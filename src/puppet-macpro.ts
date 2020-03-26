import flatten  from 'array-flatten'

import path from 'path'

import LRU from 'lru-cache'

import {
  ContactGender,
  ContactPayload,
  ContactType,
  FileBox,
  FriendshipPayload,

  MessagePayload,
  MessageType,

  Puppet,
  PuppetOptions,

  RoomInvitationPayload,
  RoomMemberPayload,
  RoomPayload,

  UrlLinkPayload,
  MiniProgramPayload,
  ScanStatus,
  ImageType,

  EventDongPayload,
  EventFriendshipPayload,
  EventLogoutPayload,
  EventMessagePayload,
  EventResetPayload,
  EventRoomJoinPayload,
  EventRoomLeavePayload,
  EventRoomTopicPayload,
  EventRoomInvitePayload,
  EventScanPayload,
}                           from 'wechaty-puppet'

import {
  GRPC_ENDPOINT,
  log,
  macproToken,
  MESSAGE_CACHE_AGE,
  MESSAGE_CACHE_MAX,
  qrCodeForChatie,
  retry,
  VERSION,
}                                   from './config'

import { ThrottleQueue, DelayQueueExecutor } from 'rx-queue'

import {
  GrpcPrivateMessagePayload,
  MacproMessageType,
  MiniProgram,
  RequestStatus,
  GrpcFriendshipRawPayload,
  GrpcPublicMessagePayload,
  GrpcLoginInfo,
  MacproMessagePayload,
  AddFriendBeforeAccept,
  MacproFriendInfo,
  MacproUrlLink,
  DeleteFriend,
  GrpcFriendshipAcceptedData,
  GrpcFriendshipAcceptedDetail,
  AcceptedType,
} from './schemas'

import { RequestClient } from './utils/request'
import { CacheManageError } from './utils/errorMsg'
import { MacproContactPayload, ContactList, GrpcContactPayload, AliasModel, GrpcContactInfo, GrpcContactRemark } from './schemas/contact'
import { CacheManager } from './cache-manager'
import { GrpcGateway } from './gateway/grpc-api'
import MacproContact from './mac-api/contact'
import MacproUser from './mac-api/user'
import MacproMessage from './mac-api/message'
import { MacproRoomPayload, GrpcRoomMemberPayload, MacproRoomInvitationPayload, MacproCreateRoom, GrpcRoomQrcode, MacproRoomMemberPayload, GrpcRoomJoin, RoomChangeState, GrpcSyncRoomListBox, GrpcSyncRoomList, GrpcRoomPayload } from './schemas/room'
import MacproRoom from './mac-api/room'
import {
  friendshipConfirmEventMessageParser,
  friendshipReceiveEventMessageParser,
  friendshipVerifyEventMessageParser,
  isStrangerV1,
  messageRawPayloadParser,
  newFriendMessageParser,
  isContactId,
} from './pure-function-helpers'
import { roomJoinEventMessageParser } from './pure-function-helpers/room-event-join-message-parser'
import { roomLeaveEventMessageParser } from './pure-function-helpers/room-event-leave-message-parser'
import { roomTopicEventMessageParser } from './pure-function-helpers/room-event-topic-message-parser'
import { messageUrlPayloadParser } from './pure-function-helpers/message-url-payload-parser'
import { roomInviteEventMessageParser } from './pure-function-helpers/room-event-invite-message-parser'

const PRE = 'PuppetMacpro'
const MEMORY_SLOT_NAME = 'WECHATY_PUPPET_MACPRO'

export interface MacproMemorySlot {
  taskId   : string,
  userName : string,
  wxid     : string,
}

export class PuppetMacpro extends Puppet {

  public static readonly VERSION = VERSION

  private readonly cacheMacproMessagePayload: LRU<string, MacproMessagePayload>

  private loopTimer?: NodeJS.Timer

  private cacheManager?: CacheManager

  private grpcGateway: GrpcGateway

  private requestClient: RequestClient

  private contact: MacproContact

  private user: MacproUser

  private message: MacproMessage

  private room: MacproRoom

  private token: string

  private memorySlot: MacproMemorySlot

  private addFriendCB: {[id: string]: any} = {}

  private reconnectThrottleQueue: ThrottleQueue

  private loginStatus: boolean

  private syncRoomQueue: DelayQueueExecutor

  private syncRoomMemberQueue: DelayQueueExecutor

  private syncContactQueue: DelayQueueExecutor

  constructor (
    public options: PuppetOptions = {},
  ) {
    super(options)
    const lruOptions: LRU.Options<string, MacproMessagePayload> = {
      dispose (key: string, val: any) {
        log.silly(PRE, `constructor() lruOptions.dispose(${key}, ${JSON.stringify(val)})`)
      },
      max: MESSAGE_CACHE_MAX,
      maxAge: MESSAGE_CACHE_AGE,
    }
    this.loginStatus = false
    this.cacheMacproMessagePayload = new LRU<string, MacproMessagePayload>(lruOptions)

    this.memorySlot = {
      taskId: '',
      userName: '',
      wxid: '',
    }

    this.token = options.token || macproToken()
    if (this.token) {
      this.grpcGateway = new GrpcGateway(this.token, GRPC_ENDPOINT)
      this.requestClient = new RequestClient(this.grpcGateway)
      this.contact = new MacproContact(this.requestClient)
      this.user = new MacproUser(this.token, this.requestClient)
      this.message = new MacproMessage(this.requestClient)
      this.room = new MacproRoom(this.requestClient)

      this.syncRoomQueue = new DelayQueueExecutor(200)
      this.syncRoomMemberQueue = new DelayQueueExecutor(200)
      this.syncContactQueue = new DelayQueueExecutor(200)

      this.reconnectThrottleQueue = new ThrottleQueue<string>(5000)
      this.reconnectThrottleQueue.subscribe(async reason => {
        log.silly('Puppet', 'constructor() reconnectThrottleQueue.subscribe() reason: %s', reason)
        if (this.grpcGateway) {
          this.grpcGateway.removeAllListeners()
        }
        delete this.requestClient
        delete this.contact
        delete this.user
        delete this.message
        delete this.room

        await this.start()
      })
    } else {
      log.error(PRE, `can not get token info from options for start grpc gateway.`)
      throw new Error(`can not get token info.`)
    }
  }

  public async start (): Promise<void> {
    log.silly(PRE, `start()`)

    this.state.on('pending')

    try {
      this.grpcGateway = new GrpcGateway(this.token, GRPC_ENDPOINT)
      await this.grpcGateway.notify('getLoginUserInfo')
    } catch (error) {
      log.info(`start grpc gateway failed for reason: ${error}, retry start in 5 seconds.`)
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.start()
      return
    }

    await this.startGrpcListener()

    this.requestClient = new RequestClient(this.grpcGateway)
    this.contact = new MacproContact(this.requestClient)
    this.user = new MacproUser(this.token, this.requestClient)
    this.message = new MacproMessage(this.requestClient)
    this.room = new MacproRoom(this.requestClient)

    this.state.on(true)
  }

  private async startGrpcListener () {
    this.grpcGateway.on('heartbeat', async () => {
      this.emit('watchdog', {
        data: 'heartbeat',
      })
    })

    /**
     * login and logout callback
     */
    this.grpcGateway.on('reconnect', () => this.reconnectThrottleQueue.next('reconnect'))

    this.grpcGateway.on('scan', data => this.onScan(data))

    this.grpcGateway.on('login', data => this.onLogin(data))

    this.grpcGateway.on('logout', () => this.onLogout())

    this.grpcGateway.on('not-login', data => this.onNotLogin(data))

    /**
     * message callback
     */
    this.grpcGateway.on('message', data => this.onProcessMessage(data))

    /**
     * sync contact and room data callback
     */
    this.grpcGateway.on('contact-list', data => this.syncContactList(data))

    this.grpcGateway.on('room-list', data => this.syncRoomList(data))

    this.grpcGateway.on('contact-info', data => this.syncContactInfo(data))

    this.grpcGateway.on('contact-remark', data => this.syncContactRemark(data))

    this.grpcGateway.on('room-info', data => this.syncRoomInfo(data))

    this.grpcGateway.on('room-join', data => this.onRoomJoin(data))

    this.grpcGateway.on('room-member', data => this.onRoomMember(data))

    this.grpcGateway.on('room-qrcode', (data: string) => {
      const _data: GrpcRoomQrcode = JSON.parse(data)
      this.room.resolveRoomQrcodeCallback(_data.group_number, _data.qrcode)
    })

    /**
     * friend request callback
     */
    this.grpcGateway.on('new-friend', data => this.onReceiveFriendsRequest(data))

    this.grpcGateway.on('add-friend', data => this.onFriendsRequestBeenAccepted(data))

    this.grpcGateway.on('del-friend', data => this.onDeleteFriend(data))

    this.grpcGateway.on('add-friend-before-accept', data => this.onFriendsRequestBeenNotAccepted(data))
  }

  /**
   * all listener functions
   */

  public async onScan (dataStr: string) {
    const data = JSON.parse(dataStr)
    if (data && data.status) {
      const eventScanPayload: EventScanPayload = {
        qrcode: '',
        status: data.status,
      }
      this.emit('scan', eventScanPayload)
    } else {
      const fileBox = FileBox.fromUrl(data.url)
      const url = await fileBox.toQRCode()
      const eventScanPayload: EventScanPayload = {
        qrcode: url,
        status: ScanStatus.Cancel,
      }
      this.emit('scan', eventScanPayload)
    }
  }

  public async onLogin (dataStr: string) {
    log.info(PRE, `
    ==============================
            Login Success
    ==============================
    `)
    const data: GrpcLoginInfo = JSON.parse(dataStr)
    const account = data.account

    log.verbose(PRE, `init cache manager`)
    await CacheManager.init(account)
    this.cacheManager = CacheManager.Instance

    const selfPayload: MacproContactPayload = {
      account: data.account,
      accountAlias: data.account_alias || data.account, // wxid
      city: '',
      description: '',
      disturb: '',
      formName: '',
      name: data.name,
      province: '',
      sex: ContactGender.Unknown,
      thumb: data.thumb,
      v1: '',
    }
    await this.cacheManager.setContact(selfPayload.accountAlias, selfPayload)

    if (!this.loginStatus) {
      await super.login(selfPayload.accountAlias)
    }
    this.loginStatus = true

    if (this.memory) {
      this.memorySlot = {
        taskId: data.task_id,
        userName: data.account,
        wxid: data.account_alias,
      }
      await this.memory.set(MEMORY_SLOT_NAME, this.memorySlot)
      await this.memory.save()
    }

    await this.contact.contactList(account)
  }

  public onLogout () {
    log.info(PRE, `
    ==============================
            Logout Success
    ==============================
    `)
    const eventLogoutPayload: EventLogoutPayload = {
      contactId: this.selfId(),
      data: '',
    }
    this.emit('logout', eventLogoutPayload)
    const eventResetPayload: EventResetPayload = {
      data: 'reset when received logout event.',
    }
    this.emit('reset', eventResetPayload)
  }

  public async onNotLogin (dataStr: string) {
    log.verbose(PRE, `
    ==============================
          grpc on not-login
    ==============================
    `)
    if (this.memory) {
      const slot = await this.memory.get(MEMORY_SLOT_NAME)
      if (slot && slot.userName) {
        log.silly(PRE, `slot : ${slot.userName}, data str : ${dataStr}`)
        await this.user.getWeChatQRCode(slot.userName)
      } else {
        await this.user.getWeChatQRCode()
      }
    } else {
      await this.user.getWeChatQRCode()
    }
  }

  protected async onProcessMessage (data: string) {
    const messagePayload: GrpcPrivateMessagePayload | GrpcPublicMessagePayload = JSON.parse(data)
    log.verbose(PRE, `onProcessMessage()`)
    const contentType = messagePayload.content_type

    if (!contentType) {
      const contactPayload = newFriendMessageParser(messagePayload as any)
      if (this.cacheManager && contactPayload !== null) {
        await this.cacheManager.setContact(contactPayload.account, contactPayload)
      }
      return
    }

    const messageId = messagePayload.msgid.toString()

    const payload: MacproMessagePayload = {
      ...messagePayload,
      content_type: contentType,
      messageId,
      timestamp: messagePayload.send_time || (Date.now() / 1000),
    }

    this.cacheMacproMessagePayload.set(messageId, payload)
    const eventMessagePayload: EventMessagePayload = {
      messageId: messageId,
    }
    switch (payload.content_type) {

      case MacproMessageType.Text:
        await this.onMacproMessageFriendshipEvent(payload)
        this.emit('message', eventMessagePayload)
        break
      case MacproMessageType.UrlLink:
        await this.onMacproMessageRoomInvitation(payload)
        break
      case MacproMessageType.Image:
      case MacproMessageType.Voice:
      case MacproMessageType.Video:
      case MacproMessageType.File:
      case MacproMessageType.PublicCard:
      case MacproMessageType.PrivateCard:
      case MacproMessageType.MiniProgram:
      case MacproMessageType.Gif:
        this.emit('message', eventMessagePayload)
        break
      case MacproMessageType.Location:
      case MacproMessageType.RedPacket:
      case MacproMessageType.MoneyTransaction:
        this.emit('message', eventMessagePayload)
        break
      case MacproMessageType.System:
        await Promise.all([
          this.onMacproMessageFriendshipEvent(payload),
          this.onMacproMessageRoomEventJoin(payload),
          this.onMacproMessageRoomEventLeave(payload),
          this.onMacproMessageRoomEventTopic(payload),
        ])
        this.emit('message', eventMessagePayload)
        break
      default:
        this.emit('message', eventMessagePayload)
        break
    }

  }

  public async syncContactList (data: string): Promise<void> {
    log.verbose(PRE, `syncContactList()`)

    const contactListInfo: ContactList = JSON.parse(data)
    const { currentPage, total, info } = contactListInfo

    await Promise.all(info.map(async (_contact: GrpcContactPayload) => {
      const contact: MacproContactPayload = {
        account: _contact.account,
        accountAlias: _contact.account_alias || _contact.account, // weixin and wxid are the same string
        city: _contact.area ? _contact.area.split('_')[1] : '',
        description: _contact.description,
        disturb: _contact.disturb,
        formName: _contact.form_name,
        name: _contact.name,
        province: _contact.area ? _contact.area.split('_')[0] : '',
        sex: parseInt(_contact.sex, 10) as ContactGender,
        thumb: _contact.thumb,
        v1: _contact.v1 || 'v1_mock_data',
      }

      if (!this.cacheManager) {
        throw CacheManageError('syncContactList()')
      }
      await this.cacheManager.setContact(contact.accountAlias, contact)
    }))
    if (currentPage * 100 > total) {
      log.verbose(PRE, `Contact data loaded. contact length: ${total}`)
    }
  }

  public async syncRoomList (data: string) {
    const _data: GrpcSyncRoomListBox = JSON.parse(data)
    const roomList: GrpcSyncRoomList[] = JSON.parse(_data.info)
    log.verbose(PRE, `syncRoomList(), length of loaded room : ${roomList.length}`)
    if (roomList && roomList.length === 0) {
      log.warn(`
        This is a new account which login wechaty based on Mac protocal first time,
        please add one room to Contacts or send message to one existed room for loading room data,
        and then just restart the bot again.
      `)
    }
    await Promise.all(roomList.map(async (room) => {
      if (this.cacheManager) {
        const roomPayload: MacproRoomPayload = {
          disturb: 0,
          members: [],
          name: room.name,
          number: room.number,
          owner: '',
          thumb: room.thumb,
        }
        await this.cacheManager.setRoom(room.number, roomPayload)
      }
    }))
  }

  public async syncContactRemark (data: string) {
    const contactRemark: GrpcContactRemark = JSON.parse(data)
    log.verbose(PRE, `syncContactRemark(), remark: ${contactRemark.remark}`)
    if (this.cacheManager) {
      const contact = await this.cacheManager.getContact(contactRemark.to_account_alias)
      if (contact) {
        contact.formName = contactRemark.remark
        await this.cacheManager.setContact(contactRemark.to_account_alias, contact)
      }
    }
  }

  public async syncContactInfo (data: string) {
    const contactInfo: GrpcContactInfo = JSON.parse(data)
    log.verbose(PRE, `syncContactInfo(), contact id : ${contactInfo.username}`)
    if (this.cacheManager) {
      const callback = this.getCallback(contactInfo.username)
      const contact: MacproContactPayload = {
        account: contactInfo.alias || '',
        accountAlias: contactInfo.username || contactInfo.alias, // wxid
        city: '',
        description: contactInfo.signature || '',
        disturb: '',
        formName: '',
        name: contactInfo.nickname,
        province: '',
        sex: ContactGender.Unknown,
        thumb: contactInfo.headurl,
        v1: '',
      }
      await this.cacheManager.setContact(contact.accountAlias, contact)
      callback(contact)
      this.removeCallback(contactInfo.username)
    }
  }

  public async syncRoomInfo (data: string) {
    const roomDetailInfo: GrpcRoomPayload = JSON.parse(data)
    log.verbose(PRE, `syncRoomInfo(), room id : ${roomDetailInfo.number}`)
    if (this.cacheManager) {
      let cacheRoom = await this.cacheManager.getRoom(roomDetailInfo.number)
      if (!cacheRoom) {
        cacheRoom = {
          disturb: 0,
          members: [],
          name: roomDetailInfo.name,
          number: roomDetailInfo.number,
          owner: roomDetailInfo.author,
          thumb: roomDetailInfo.thumb,
        }
      } else {
        cacheRoom.owner = roomDetailInfo.author
        cacheRoom.thumb = roomDetailInfo.thumb
      }

      await this.syncRoomMemberQueue.execute(async () => {
        await this.room.roomMember(this.selfId(), cacheRoom!.number)
      })

      await new Promise((resolve) => {
        const timeout = setTimeout(async () => {
          log.error(PRE, `can not load room member, room id : ${cacheRoom!.number}`)
          await this.room.roomMember(this.selfId(), cacheRoom!.number)
        }, 3000)
        this.room.pushRoomMemberCallback(cacheRoom!.number, async (macproMembers) => {
          clearTimeout(timeout)
          cacheRoom!.members = macproMembers
          if (!this.cacheManager) {
            throw CacheManageError('pushRoomMemberCallback()')
          }
          await this.cacheManager.setRoom(cacheRoom!.number, cacheRoom!)
          this.room.resolveRoomCallback(cacheRoom!.number, cacheRoom!)
          resolve()
        })
      })
    }
  }

  public async onRoomJoin (data: string) {
    const _data: GrpcRoomJoin = JSON.parse(data)
    log.silly(PRE, `onRoomJoin(), new member's name : ${_data.name}, wxid: ${_data.account}`)

    if (!this.cacheManager) {
      throw new Error(`no cacheManager`)
    }
    const roomId = _data.g_number
    const roomMembers = await this.cacheManager.getRoomMember(roomId)
    if (!roomMembers && _data.type === RoomChangeState.JOIN) {
      await this.room.syncRoomDetailInfo(this.selfId(), _data.g_number)
    }
    if (roomMembers && _data.type === RoomChangeState.JOIN) {
      let memberPayload: MacproRoomMemberPayload
      if (roomMembers[_data.account]) {
        memberPayload = roomMembers[_data.account]
        memberPayload.account = _data.account
        memberPayload.name = _data.name
      } else {
        memberPayload = {
          account: _data.account,
          accountAlias: _data.account,
          city: '',
          description: '',
          disturb: '',
          formName: '',
          name: _data.name,
          province: '',
          sex: ContactGender.Unknown,
          thumb: '',
          v1: '',
        }
      }
      roomMembers[_data.account] = memberPayload
      await this.cacheManager.setRoomMember(roomId, roomMembers)
      const _contact = await this.cacheManager.getContact(_data.account)
      if (!_contact) {
        const contact: MacproContactPayload = {
          account: _data.account,
          accountAlias: _data.account,
          city: '',
          description: '',
          disturb: '',
          formName: '',
          name: _data.name,
          province: '',
          sex: ContactGender.Unknown,
          thumb: '',
          v1: '',
        }
        await this.cacheManager.setContact(_data.account, contact)
      }
    }
  }

  public async onRoomMember (members: string) {
    log.silly(PRE, `onRoomMember`)
    const _members: GrpcRoomMemberPayload[] = JSON.parse(members).memberList
    const macproMembers: MacproRoomMemberPayload[] = []
    let payload: { [contactId: string]: MacproRoomMemberPayload } = {}
    _members.map(async member => {
      if (member.userName) {
        const roomMemberPayload: MacproRoomMemberPayload = {
          account: member.userName,
          accountAlias: member.userName,
          city: '',
          description: '',
          disturb: '',
          formName: member.displayName,
          name: member.nickName,
          province: '',
          sex: ContactGender.Unknown,
          thumb: member.bigHeadImgUrl,
          v1: '',
        }
        macproMembers.push(roomMemberPayload)
        payload[member.userName] = roomMemberPayload
        if (!this.cacheManager) {
          throw CacheManageError('ROOM-MEMBER')
        }

        const _contact = await this.cacheManager.getContact(member.userName)
        if (!_contact) {
          const contact: MacproContactPayload = {
            account: member.userName,
            accountAlias: member.userName,
            city: '',
            description: '',
            disturb: '',
            formName: member.displayName,
            name: member.nickName,
            province: '',
            sex: ContactGender.Unknown,
            thumb: member.bigHeadImgUrl,
            v1: '',
          }
          await this.cacheManager.setContact(member.userName, contact)
        }
        await this.cacheManager.setRoomMember(member.number, payload)
      } else {
        log.silly(PRE, `can not get member user name`)
      }
    })

    this.room.resolveRoomMemberCallback(_members[0] && _members[0].number, macproMembers)
  }

  public async onReceiveFriendsRequest (data: string) {
    const friendshipRawPayload: GrpcFriendshipRawPayload = JSON.parse(data)
    log.silly(PRE, `onReceiveFriendsRequest(), friend name : ${friendshipRawPayload.nickname}`)

    if (!this.cacheManager) {
      log.verbose(`Can not save friendship raw payload to cache since cache manager is not inited.`)
      return
    }
    const payload = friendshipReceiveEventMessageParser(friendshipRawPayload)
    if (payload) {
      await this.cacheManager.setFriendshipRawPayload(payload.contactId, payload)
      const eventFriendshipPayload: EventFriendshipPayload = {
        friendshipId: payload.contactId,
      }
      this.emit('friendship', eventFriendshipPayload)
    }
  }

  public async onFriendsRequestBeenAccepted (data: string) {
    const grpcFriendshipAcceptedData: GrpcFriendshipAcceptedData = JSON.parse(data)
    const type = grpcFriendshipAcceptedData.type
    if (type === AcceptedType.BOT) {
      log.silly(`The bot's friend request has been accepted.`)
    } else if (type === AcceptedType.OTHERS) {
      log.silly(`The bot accepted the friend request from others.`)
    } else {
      throw new Error(`Can not parse this type : ${type}, data: ${data}`)
    }
    log.silly(PRE, `onFriendsRequestBeenAccepted(), new contact info : ${grpcFriendshipAcceptedData.data}`)
    const newContact: GrpcFriendshipAcceptedDetail = JSON.parse(grpcFriendshipAcceptedData.data)
    const contact: MacproContactPayload = {
      account: newContact.account,
      accountAlias: newContact.account_alias || newContact.account,
      city: newContact.area ? newContact.area.split('_')[1] : '',
      description: '',
      disturb: '',
      formName: '',
      name: newContact.name,
      province: newContact.area ? newContact.area.split('_')[0] : '',
      sex: Number(newContact.sex) as ContactGender,
      thumb: newContact.thumb,
      v1: grpcFriendshipAcceptedData.v1,
    }
    if (this.cacheManager) {
      await this.cacheManager.setContact(contact.accountAlias, contact)
    }
  }

  public async onDeleteFriend (data: string) {
    const _data: DeleteFriend = JSON.parse(data)
    log.silly(PRE, `onDeleteFriend(), user: ${_data.account} has been deleted by bot.`)
    if (_data && _data.account) {
      if (isContactId(_data.account)) {
        if (this.cacheManager) {
          await this.cacheManager.deleteContact(_data.account)
        }
      }
    }
  }

  public async onFriendsRequestBeenNotAccepted (data: string) {
    log.silly(PRE, `onFriendsRequestBeenNotAccepted(), data : ${data}`) // to_account -> WeChat account

    const _data: AddFriendBeforeAccept = JSON.parse(data)
    const phoneOrAccount = _data.phone || _data.to_name

    const unique = this.selfId() + phoneOrAccount
    const cb = this.addFriendCB[unique]
    if (cb) {
      const friendInfo: MacproFriendInfo = {
        friendAccount: _data.to_name,
        friendPhone: _data.phone,
        friendThumb: _data.to_thumb,
        myAccount: _data.my_account,
      }
      cb(friendInfo)
    }
  }

  public async stop (): Promise<void> {

    log.silly(PRE, 'stop()')

    if (this.state.off()) {
      log.warn(PRE, 'stop() is called on a OFF puppet. await ready(off) and return.')
      await this.state.ready('off')
      return
    }

    this.state.off('pending')

    await CacheManager.release()
    await this.grpcGateway.stop()
    this.grpcGateway.removeAllListeners()

    this.state.off(true)
  }

  public async logout (): Promise<void> {

    log.silly(PRE, 'logout()')

    await this.user.logoutWeChat(this.selfId())
  }

  /**
   *
   * ContactSelf
   *
   *
   */
  public async contactSelfQRCode (): Promise<string> {
    log.verbose(PRE, 'contactSelfQRCode()')

    throw new Error('not supported')
  }

  public async contactSelfName (name: string): Promise<void> {
    log.verbose(PRE, 'contactSelfName(%s)', name)

    throw new Error('not supported')
  }

  public async contactSelfSignature (signature: string): Promise<void> {
    log.verbose(PRE, 'contactSelfSignature(%s)', signature)

    throw new Error('not supported')
  }

  /**
   *
   * Tags
   *
   */
  public async tagContactAdd (name: string, contactId: string) : Promise<void> {
    log.silly(`tagContactAdd(${name}, ${contactId})`)
    const tagId = await this.contact.createTag(this.selfId(), name)
    await this.contact.addTag(this.selfId(), tagId, contactId)
  }

  public async tagContactRemove (name: string, contactId: string) : Promise<void> {
    log.silly(PRE, `tagContactRemove()`)
    const tagId = await this.contact.createTag(this.selfId(), name)
    await this.contact.removeTag(this.selfId(), tagId, contactId)
  }

  public async tagContactDelete (id: string) : Promise<void> {
    log.silly(`tagContactDelete(${id})`)

    await this.contact.deleteTag(this.selfId(), id)
  }

  public async tagContactList (contactId?: string) : Promise<string[]> {
    log.error(`tagContactList not supported, ${contactId}`)
    await this.contact.tags(this.selfId(), contactId)
    return []
  }

  /**
   *
   * Contact
   *
   */
  private poolMap: { [requestId: string]: (data: MacproContactPayload) => void } = {}
  private pushCallbackToPool (requestId: string, callback: (data: MacproContactPayload) => void) {
    this.poolMap[requestId] = callback
  }
  private getCallback (requestId: string) {
    return this.poolMap[requestId]
  }
  private removeCallback (requestId: string) {
    delete this.poolMap[requestId]
  }

  public async contactRawPayload (id: string): Promise<MacproContactPayload> {
    log.verbose(PRE, 'contactRawPayload(%s)', id)
    if (!this.cacheManager) {
      throw CacheManageError('contactRawPayload()')
    }

    let rawPayload = await this.cacheManager.getContact(id)

    if (!rawPayload) {
      await this.syncContactQueue.execute(async () => {
        await this.contact.syncContactInfo(this.selfId(), id)
      })

      return new Promise(resolve => {
        this.pushCallbackToPool(id, (data: MacproContactPayload) => {
          resolve(data)
        })
      })
    }
    return rawPayload
  }

  public async contactRawPayloadParser (rawPayload: MacproContactPayload): Promise<ContactPayload> {
    log.verbose(PRE, 'contactRawPayloadParser()')

    const payload: ContactPayload = {
      address   : rawPayload.province + ',' + rawPayload.city,
      alias     : rawPayload.formName,
      avatar    : rawPayload.thumb,
      city      : rawPayload.city,
      friend    : isStrangerV1(rawPayload.v1),
      gender    : rawPayload.sex,
      id        : rawPayload.accountAlias,
      name      : rawPayload.name,
      province  : rawPayload.province,
      signature : rawPayload.description,
      type      : ContactType.Personal,
      weixin    : rawPayload.account,
    }
    return payload
  }

  public contactAlias (contactId: string)                      : Promise<string>
  public contactAlias (contactId: string, alias: string | null): Promise<void>

  public async contactAlias (contactId: string, alias?: string | null): Promise<void | string> {
    log.verbose(PRE, 'contactAlias(%s, %s)', contactId, alias)

    if (!this.cacheManager) {
      throw CacheManageError('contactAlias()')
    }

    if (typeof alias === 'undefined') {
      const contact = await this.cacheManager.getContact(contactId)

      if (!contact) {
        throw new Error(`Can not find the contact by ${contactId}`)
      }

      return contact.formName
    } else {
      const aliasModel: AliasModel = {
        contactId,
        loginedId: this.selfId(),
        remark: alias || '',
      }
      const res = await this.contact.setAlias(aliasModel)
      if (res === RequestStatus.Success) {
        if (!this.cacheManager) {
          throw new Error(`no cacheManager`)
        }
        const contact = await this.cacheManager.getContact(contactId)
        if (!contact) {
          throw new Error(`can not find contact by id : ${contactId}`)
        }
        contact.formName = alias!
        await this.cacheManager.setContact(contactId, contact)
      }
    }
  }

  public async contactList (): Promise<string[]> {
    log.verbose(PRE, 'contactList()')

    if (!this.cacheManager) {
      throw CacheManageError('contactList()')
    }

    return this.cacheManager.getContactIds()
  }

  public async contactQrcode (contactId: string): Promise<string> {
    if (contactId !== this.selfId()) {
      throw new Error('can not set avatar for others')
    }

    throw new Error('not supported')
  }

  public async contactAvatar (contactId: string)                : Promise<FileBox>
  public async contactAvatar (contactId: string, file: FileBox) : Promise<void>

  public async contactAvatar (contactId: string, file?: FileBox): Promise<void | FileBox> {
    log.verbose(PRE, 'contactAvatar(%s)', contactId)

    /**
     * 1. set
     */
    if (file) {
      throw new Error('not supported')
    }

    /**
     * 2. get
     */
    if (!this.cacheManager) {
      throw CacheManageError('contactAvatar()')
    }

    const contact = await this.cacheManager.getContact(contactId)

    if (!contact) {
      throw new Error(`Can not find the contact by ${contactId}`)
    }

    return FileBox.fromUrl(contact.thumb)
  }

  /**
   *
   * Message
   *
   */
  public async messageSendText (
    conversationId : string,
    text     : string,
    mentionIdList?: string[],
  ): Promise<void> {

    log.silly(PRE, 'messageSend(%s, %s)', conversationId, text)

    if (this.selfId()) {
      if (mentionIdList && mentionIdList.length > 0) {
        await this.room.atRoomMember(this.selfId(), conversationId, mentionIdList.join(','), text)
      } else {
        await this.message.sendMessage(this.selfId(), conversationId, text, MacproMessageType.Text)
      }
    } else {
      throw new Error('Can not get the logined account id')
    }

  }

  public async messageSendFile (
    conversationId : string,
    file     : FileBox,
  ): Promise<void> {
    log.verbose(PRE, 'messageSendFile(%s, %s)', conversationId, file)

    const fileUrl = await this.generatorFileUrl(file)

    await file.ready()

    const type = (file.mimeType && file.mimeType !== 'application/octet-stream')
      ? file.mimeType
      : path.extname(file.name)

    log.silly(PRE, `fileType : ${type}`)
    switch (type) {
      case 'binary/octet-stream':
      case '.slk':
      case '.silk':
        await this.message.sendMessage(this.selfId(), conversationId, fileUrl, MacproMessageType.Voice, undefined, file.metadata.voiceLength)
        break
      case 'image/jpeg':
      case 'image/png':
      case '.jpg':
      case '.jpeg':
      case '.png':
        await this.message.sendMessage(this.selfId(), conversationId, fileUrl, MacproMessageType.Image)
        break
      case '.mp4':
      case 'video/mp4':
        await this.message.sendMessage(this.selfId(), conversationId, fileUrl, MacproMessageType.Video)
        break
      default:
        await this.message.sendMessage(this.selfId(), conversationId, fileUrl, MacproMessageType.File, file.name)
        break
    }

  }

  public async messageRecall (messageId: string): Promise<boolean> {
    throw new Error('Method not implemented. id: ' + messageId)
  }

  private async generatorFileUrl (file: FileBox): Promise<string> {
    log.verbose(PRE, 'generatorFileUrl(%s)', file)
    const url = await this.requestClient.uploadFile(file.name, await file.toStream())
    return url
  }

  public async messageSendUrl (
    conversationId: string,
    urlLinkPayload: UrlLinkPayload
  ) : Promise<void> {
    log.verbose(PRE, 'messageSendUrl("%s", %s)',
      conversationId,
      JSON.stringify(urlLinkPayload),
    )

    const { url, title, thumbnailUrl, description } = urlLinkPayload

    const payload: MacproUrlLink = {
      description,
      thumbnailUrl,
      title,
      url,
    }
    await this.message.sendUrlLink(this.selfId(), conversationId, payload)
  }

  public async messageRawPayload (id: string): Promise<MacproMessagePayload> {
    log.verbose(PRE, 'messageRawPayload(%s)', id)

    const rawPayload = this.cacheMacproMessagePayload.get(id)
    if (!rawPayload) {
      throw new Error('no rawPayload')
    }

    return rawPayload
  }

  public async messageRawPayloadParser (rawPayload: MacproMessagePayload): Promise<MessagePayload> {
    log.verbose(PRE, 'messageRawPayloadParser(%s)', JSON.stringify(rawPayload))

    const payload = await messageRawPayloadParser(rawPayload)
    if (payload.mentionIdList && payload.mentionIdList.length === 1 && payload.mentionIdList[0] === 'announcement@all') {
      const memberIds = await this.roomMemberList(payload.roomId!)
      payload.mentionIdList = memberIds.filter(m => m !== payload.fromId)
      payload.text = `${payload.text || ''}`
    }
    return payload
  }

  private async onMacproMessageFriendshipEvent (rawPayload: MacproMessagePayload): Promise<boolean> {
    log.verbose(PRE, 'onMacproMessageFriendshipEvent({id=%s})', rawPayload.messageId)
    /**
     * 1. Look for friendship confirm event
     */
    const confirmPayload = friendshipConfirmEventMessageParser(rawPayload)
    /**
     * 2. Look for friendship verify event
     */
    const verifyPayload = friendshipVerifyEventMessageParser(rawPayload)

    if (confirmPayload || verifyPayload) {
      const payload = confirmPayload || verifyPayload
      if (this.cacheManager) {
        await this.cacheManager.setFriendshipRawPayload(rawPayload.messageId, payload!)
        const eventFriendshipPayload: EventFriendshipPayload = {
          friendshipId: rawPayload.messageId,
        }
        this.emit('friendship', eventFriendshipPayload)
        return true
      }
    }
    return false
  }

  private async onMacproMessageRoomEventJoin (rawPayload: MacproMessagePayload): Promise<boolean> {
    log.verbose(PRE, 'onMacproMessageRoomEventJoin({id=%s})', rawPayload.messageId)

    const roomJoinEvent = await roomJoinEventMessageParser(rawPayload)

    if (roomJoinEvent) {
      const inviteeNameList = roomJoinEvent.inviteeNameList
      const inviterName     = roomJoinEvent.inviterName
      const roomId          = roomJoinEvent.roomId
      const timestamp       = roomJoinEvent.timestamp
      log.silly(PRE, 'onMacproMessageRoomEventJoin() roomJoinEvent="%s"', JSON.stringify(roomJoinEvent))

      const inviteeIdList = await retry(async (retryException, attempt) => {
        log.verbose(PRE, 'onMacproMessageRoomEventJoin({id=%s}) roomJoin retry(attempt=%d)', attempt)

        const tryIdList = flatten<string>(
          await Promise.all(
            inviteeNameList.map(
              inviteeName => this.roomMemberSearch(roomId, inviteeName),
            ),
          ),
        )

        if (tryIdList.length) {
          return tryIdList
        }

        /**
         * Set Cache Dirty
         */
        await this.roomMemberPayloadDirty(roomId)

        return retryException(new Error('roomMemberSearch() not found'))

      }).catch(e => {
        log.verbose(PRE, 'onMacproMessageRoomEventJoin({id=%s}) roomJoin retry() fail: %s', e.message)
        return [] as string[]
      })

      const inviterIdList = await this.roomMemberSearch(roomId, inviterName)

      if (inviterIdList.length < 1) {
        throw new Error('no inviterId found')
      } else if (inviterIdList.length > 1) {
        log.verbose(PRE, 'onMacproMessageRoomEventJoin() inviterId found more than 1, use the first one.')
      }

      const inviterId = inviterIdList[0]

      /**
       * Set Cache Dirty
       */
      await this.roomMemberPayloadDirty(roomId)
      await this.roomPayloadDirty(roomId)

      const eventRoomJoinPayload: EventRoomJoinPayload = {
        inviteeIdList,
        inviterId,
        roomId,
        timestamp,
      }
      this.emit('room-join', eventRoomJoinPayload)
      return true
    }
    return false
  }

  private async onMacproMessageRoomEventLeave (rawPayload: MacproMessagePayload): Promise<boolean> {
    log.verbose(PRE, 'onMacproMessageRoomEventLeave({id=%s})', rawPayload.messageId)

    const roomLeaveEvent = roomLeaveEventMessageParser(rawPayload)

    if (roomLeaveEvent) {
      const leaverNameList = roomLeaveEvent.leaverNameList
      const removerName    = roomLeaveEvent.removerName
      const roomId         = roomLeaveEvent.roomId
      const timestamp      = roomLeaveEvent.timestamp
      log.silly(PRE, 'onMacproMessageRoomEventLeave() roomLeaveEvent="%s"', JSON.stringify(roomLeaveEvent))

      const leaverIdList = flatten<string>(
        await Promise.all(
          leaverNameList.map(
            leaverName => this.roomMemberSearch(roomId, leaverName),
          ),
        ),
      )
      const removerIdList = await this.roomMemberSearch(roomId, removerName)
      if (removerIdList.length < 1) {
        throw new Error('no removerId found')
      } else if (removerIdList.length > 1) {
        log.verbose(PRE, 'onMacproMessageRoomEventLeave(): removerId found more than 1, use the first one.')
      }
      const removerId = removerIdList[0]

      /**
       * Set Cache Dirty
       */
      await this.roomMemberPayloadDirty(roomId)
      await this.roomPayloadDirty(roomId)

      const eventRoomLeavePayload: EventRoomLeavePayload = {
        removeeIdList: leaverIdList,
        removerId,
        roomId,
        timestamp,
      }
      this.emit('room-leave', eventRoomLeavePayload)
      return true
    }
    return false
  }

  private async onMacproMessageRoomEventTopic (rawPayload: MacproMessagePayload): Promise<boolean> {
    log.verbose(PRE, 'onMacproMessageRoomEventTopic({id=%s})', rawPayload.messageId)

    const roomTopicEvent = roomTopicEventMessageParser(rawPayload)
    if (roomTopicEvent) {
      const changerName = roomTopicEvent.changerName
      const newTopic    = roomTopicEvent.topic
      const roomId      = roomTopicEvent.roomId
      const timestamp   = roomTopicEvent.timestamp
      log.silly(PRE, 'onMacproMessageRoomEventTopic() roomTopicEvent="%s"', JSON.stringify(roomTopicEvent))

      const roomOldPayload = await this.roomPayload(roomId)
      const oldTopic       = roomOldPayload.topic

      const changerIdList = await this.roomMemberSearch(roomId, changerName)
      if (changerIdList.length < 1) {
        throw new Error('no changerId found')
      } else if (changerIdList.length > 1) {
        log.verbose(PRE, 'onMacproMessageRoomEventTopic() changerId found more than 1, use the first one.')
      }
      const changerId = changerIdList[0]

      /**
       * Set Cache Dirty
       */
      await this.roomPayloadDirty(roomId)
      if (this.cacheManager) {
        const room = await this.cacheManager.getRoom(roomId)
        if (room) {
          room.name = roomTopicEvent.topic
          await this.cacheManager.setRoom(roomId, room)
        }
      }

      const eventRoomTopicPayload: EventRoomTopicPayload = {
        changerId,
        newTopic,
        oldTopic,
        roomId,
        timestamp,
      }
      this.emit('room-topic', eventRoomTopicPayload)
      return true
    }
    return false
  }

  public async onMacproMessageRoomInvitation (payload: MacproMessagePayload): Promise<void> {
    log.verbose(PRE, 'onMacproMessageRoomInvitation(%s)', JSON.stringify(payload))
    const roomInviteEvent = await roomInviteEventMessageParser(payload)

    if (roomInviteEvent) {
      if (!this.cacheManager) {
        throw CacheManageError('contactAvatar()')
      }
      await this.cacheManager.setRoomInvitation(roomInviteEvent.id, roomInviteEvent)
      const eventRoomInvitePayload: EventRoomInvitePayload = {
        roomInvitationId: roomInviteEvent.id,
      }
      this.emit('room-invite', eventRoomInvitePayload)
    } else {
      const eventMessagePayload: EventMessagePayload = {
        messageId: payload.messageId,
      }
      this.emit('message', eventMessagePayload)
    }
  }

  public async messageSendContact (
    conversationId  : string,
    contactId : string,
  ): Promise<void> {
    log.verbose(PRE, 'messageSend("%s", %s)', conversationId, contactId)

    await this.message.sendContact(this.selfId(), conversationId, contactId)
  }

  // 发送小程序
  public async messageSendMiniProgram (
    conversationId: string,
    miniProgramPayload: MiniProgramPayload,
  ): Promise<void> {
    log.verbose(PRE, 'messageSendMiniProgram()')

    const {
      // username, // UNKNOW
      appid, // 小程序关联的微信公众号ID
      title,
      pagePath,
      description,
      thumbUrl,
      thumbKey,
    } = miniProgramPayload

    const _miniProgram: MiniProgram = {
      app_name: appid! + '@app',
      describe: description,
      my_account: this.selfId(),
      page_path: pagePath,
      thumb_key: thumbKey,
      thumb_url: thumbUrl,
      title: title!,
      to_account: conversationId,
    }
    await this.message.sendMiniProgram(_miniProgram)
  }

  public async messageForward (
    conversationId  : string,
    messageId : string,
  ): Promise<void> {
    log.verbose(PRE, 'messageForward(%s, %s)',
      conversationId,
      messageId,
    )

    const payload = await this.messagePayload(messageId)

    if (payload.type === MessageType.Text) {
      if (!payload.text) {
        throw new Error('no text')
      }
      await this.messageSendText(
        conversationId,
        payload.text,
      )
    } else if (payload.type === MessageType.Url) {
      await this.messageSendUrl(
        conversationId,
        await this.messageUrl(messageId)
      )
    } else if (payload.type === MessageType.MiniProgram) {
      await this.messageSendMiniProgram(
        conversationId,
        await this.messageMiniProgram(messageId)
      )
    } else if (payload.type === MessageType.ChatHistory) {
      throw new Error(`not support`)
    } else {
      await this.messageSendFile(
        conversationId,
        await this.messageFile(messageId),
      )
    }
  }

  // TODO: 转发小程序
  public async messageMiniProgram (messageId: string)  : Promise<MiniProgramPayload> {
    log.verbose(PRE, 'messageMiniProgram(%s)', messageId)

    return {
      title : 'Macpro title for ' + messageId,
      username: '',
    }
  }

  public async messageContact (messageId: string): Promise<string> {
    log.warn(`messageContact() need to be implemented, ${messageId}`)
    throw new Error(`messageContact() not supported now`)
  }

  public async messageImage (messageId: string, imageType: ImageType): Promise<FileBox> {
    log.warn(`messageImage() need to be implemented, ${messageId}, ${imageType}`)
    throw new Error(`messageImage() not support`)
  }

  public async messageFile (id: string): Promise<FileBox> {
    log.info(PRE, `messageFile(${id})`)
    if (!this.cacheManager) {
      throw new Error(`Can not get filebox from message since no cache manager.`)
    }
    const messagePayload = this.cacheMacproMessagePayload.get(id)
    if (!messagePayload) {
      throw new Error(`Can not get filebox from message since no message for id: ${id}.`)
    }
    const messageType = messagePayload.content_type
    const supportedMessageTypeToFileBox = [
      MacproMessageType.File,
      MacproMessageType.Image,
      MacproMessageType.Video,
      MacproMessageType.Voice,
      MacproMessageType.Gif,
    ]
    if (supportedMessageTypeToFileBox.includes(messageType)) {
      let fileBox = FileBox.fromUrl(messagePayload.content)
      if (messageType === MacproMessageType.Voice) {
        if (messagePayload.content.indexOf('.silk') !== -1) {
          const url = messagePayload.content
          fileBox = FileBox.fromUrl(url)
          fileBox.metadata = {
            voiceLength: messagePayload.voice_len,
          }
        } else {
          throw new Error(`can not get the silk url for this voice.`)
        }
      } else if (messageType === MacproMessageType.File) {
        fileBox.metadata = {
          fileName: messagePayload.file_name ? messagePayload.file_name : '未命名',
        }
      }
      return fileBox
    } else {
      throw new Error(`Can not get filebox for message type: ${MacproMessageType[messageType]}`)
    }
  }

  public async messageUrl (messageId: string)  : Promise<UrlLinkPayload> {
    log.verbose(PRE, 'messageUrl(%s)')

    const payload = this.cacheMacproMessagePayload.get(messageId)
    if (!payload) {
      throw new Error(`Can not get url from message, since there is no message with id: ${messageId}`)
    }
    const urlLinkPayload = messageUrlPayloadParser(payload)

    if (!urlLinkPayload) {
      throw new Error(`Parse url link from message failed.`)
    }

    return urlLinkPayload
  }

  /**
   *
   * Room
   *
   */
  public async roomRawPayload (
    roomId: string,
  ): Promise<MacproRoomPayload> {
    log.verbose(PRE, 'roomRawPayload(%s)', roomId)

    if (!this.cacheManager) {
      throw CacheManageError('roomRawPayload()')
    }

    let rawPayload = await this.cacheManager.getRoom(roomId)
    if (!rawPayload || rawPayload.members.length === 0 || rawPayload.owner === '') {
      await this.syncRoomQueue.execute(async () => {
        await this.room.syncRoomDetailInfo(this.selfId(), roomId)
      })

      return new Promise((resolve) => {
        const timeout = setTimeout(async () => {
          log.error(PRE, `can not load room, room id : ${roomId}`)
          await this.room.syncRoomDetailInfo(this.selfId(), roomId)
        }, 3000)
        this.room.pushRoomCallback(roomId, async (room: MacproRoomPayload) => {
          clearTimeout(timeout)
          resolve(room)
        })
      })
    } else {
      return rawPayload
    }
  }

  public async roomRawPayloadParser (
    rawPayload: MacproRoomPayload,
  ): Promise<RoomPayload> {
    log.verbose(PRE, 'roomRawPayloadParser()')
    const payload: RoomPayload = {
      adminIdList: [],
      avatar: rawPayload.thumb,
      id : rawPayload.number,
      memberIdList : rawPayload.members.map(m => m.account) || [],
      ownerId: rawPayload.owner,
      topic: rawPayload.name,
    }

    return payload
  }

  public async roomList (): Promise<string[]> {
    log.verbose(PRE, 'roomList()')

    if (!this.cacheManager) {
      throw CacheManageError(`roomList()`)
    }
    const roomIdList = await this.cacheManager.getRoomIds()
    return roomIdList
  }

  public async roomMemberList (roomId: string) : Promise<string[]> {
    log.verbose(PRE, 'roomMemberList(%s)', roomId)

    if (!this.cacheManager) {
      throw CacheManageError('roomMemberList()')
    }

    let roomMemberListPayload = await this.cacheManager.getRoomMember(roomId)

    if (roomMemberListPayload === undefined) {
      roomMemberListPayload = {}

      await this.room.roomMember(this.selfId(), roomId)

      return new Promise((resolve) => {
        this.room.pushRoomMemberCallback(roomId, async (macproMembers) => {
          macproMembers.map(member => {
            roomMemberListPayload![member.accountAlias] = member
          })
          if (roomMemberListPayload) {
            if (!this.cacheManager) {
              throw CacheManageError('pushRoomMemberCallback()')
            }
            await this.cacheManager.setRoomMember(roomId, roomMemberListPayload)
            resolve(Object.keys(roomMemberListPayload))
          } else {
            throw new Error(`can not get room members by roomId: ${roomId}`)
          }
        })
      })
    }
    return Object.keys(roomMemberListPayload)
  }

  public async roomMemberRawPayload (roomId: string, contactId: string): Promise<MacproRoomMemberPayload>  {
    log.verbose(PRE, 'roomMemberRawPayload(%s, %s)', roomId, contactId)

    if (!this.cacheManager) {
      throw CacheManageError('roomMemberRawPayload()')
    }
    let roomMemberListPayload = await this.cacheManager.getRoomMember(roomId)
    if (roomMemberListPayload === undefined) {
      roomMemberListPayload = {}

      await this.room.roomMember(this.selfId(), roomId)

      this.room.pushRoomMemberCallback(roomId, async (macproMembers) => {
        macproMembers.map(member => {
          roomMemberListPayload![member.accountAlias] = member
        })
        if (roomMemberListPayload) {
          if (!this.cacheManager) {
            throw CacheManageError('pushRoomMemberCallback()')
          }
          await this.cacheManager.setRoomMember(roomId, roomMemberListPayload)
        } else {
          throw new Error(`can not get room members by roomId: ${roomId}`)
        }
      })
    }
    return roomMemberListPayload[contactId]
  }

  public async roomMemberRawPayloadParser (rawPayload: GrpcRoomMemberPayload): Promise<RoomMemberPayload>  {
    log.verbose(PRE, 'roomMemberRawPayloadParser(%s)', rawPayload)

    const payload: RoomMemberPayload = {
      avatar: rawPayload.bigHeadImgUrl,
      id: rawPayload.userName,
      // inviterId: ??
      name: rawPayload.nickName,
      roomAlias: rawPayload.displayName,
    }

    return payload
  }

  public async roomAvatar (roomId: string): Promise<FileBox> {
    log.verbose(PRE, 'roomAvatar(%s)', roomId)

    if (!this.cacheManager) {
      throw CacheManageError(`roomAvatar()`)
    }

    const payload = await this.cacheManager.getRoom(roomId)

    if (payload && payload.thumb) {
      return FileBox.fromUrl(payload.thumb)
    }
    log.warn(PRE, 'roomAvatar() avatar not found, use the chatie default.')
    return qrCodeForChatie()
  }

  public async roomTopic (roomId: string)                : Promise<string>
  public async roomTopic (roomId: string, topic: string) : Promise<void>

  public async roomTopic (
    roomId: string,
    topic?: string,
  ): Promise<void | string> {
    log.verbose(PRE, 'roomTopic(%s, %s)', roomId, topic)

    if (topic) {
      await this.room.modifyRoomTopic(this.selfId(), roomId, topic)

      if (!this.cacheManager) {
        throw CacheManageError('roomTopic()')
      }
      const room = await this.cacheManager.getRoom(roomId)
      if (!room) {
        throw new Error(`can not get room from cache by room id: ${roomId}.`)
      }
      room.name = topic
      await this.cacheManager.setRoom(roomId, room)
    } else {
      if (!this.cacheManager) {
        throw CacheManageError('roomTopic()')
      }

      const roomPayload = await this.cacheManager.getRoom(roomId)
      if (!roomPayload) {
        throw new Error(`can not get room from cache by room id: ${roomId}.`)
      }
      return roomPayload.name
    }

  }

  public async roomCreate (
    contactIdList: string[],
    topic?: string,
  ): Promise<string> {
    log.verbose(PRE, 'roomCreate(%s, %s)', contactIdList, topic)

    await this.room.createRoom(this.selfId(), contactIdList, topic)

    return new Promise<string>((resolve) => {
      this.grpcGateway.on('room-create', async data => {
        const roomCreate: MacproCreateRoom = JSON.parse(data)
        const roomId = roomCreate.account
        await this.room.syncRoomDetailInfo(this.selfId(), roomId)
        resolve(roomId)
      })
    })

  }

  public async roomAdd (
    roomId    : string,
    contactId : string,
  ): Promise<void> {
    log.verbose(PRE, 'roomAdd(%s, %s)', roomId, contactId)

    const accountId = await this.getAccountId(contactId)
    if (accountId === '') {
      throw new Error(`can not get accountId for ADD MEMBER to ROOM : ${contactId}`)
    }
    const room = await this.roomRawPayload(roomId)
    const roomMemberNum = room.members && room.members.length

    if (roomMemberNum < 40) {
      await this.room.roomAdd(this.selfId(), roomId, accountId)
    } else {
      await this.room.roomInvite(this.selfId(), roomId, accountId)
    }
  }

  private async getAccountId (id: string): Promise<string> {
    if (!this.cacheManager) {
      throw CacheManageError('getAccountId()')
    }
    const contact = await this.cacheManager.getContact(id)
    if (contact && contact.account !== contact.accountAlias) {
      return contact.account
    } else if (contact && contact.account) {
      return contact.accountAlias
    } else {
      return ''
    }
  }

  public async roomDel (
    roomId    : string,
    contactId : string,
  ): Promise<void> {
    log.verbose(PRE, 'roomDel(%s, %s)', roomId, contactId)

    const accountId = await this.getAccountId(contactId)
    if (accountId === '') {
      throw new Error(`can not get accountId for DELETE MEMBER to ROOM : ${contactId}`)
    }
    const res = await this.room.roomDel(this.selfId(), roomId, accountId)
    if (res === RequestStatus.Success) {
      if (!this.cacheManager) {
        throw new Error(`no cacheManager`)
      }
      const roomMembers = await this.cacheManager.getRoomMember(roomId)
      if (!roomMembers) {
        throw new Error(`can not get room member from cache by roomId: ${roomId}`)
      }
      delete roomMembers[contactId]
      await this.cacheManager.setRoomMember(roomId, roomMembers)
    }
  }

  public async roomQuit (roomId: string): Promise<void> {
    log.verbose(PRE, 'roomQuit(%s)', roomId)

    await this.room.roomQuit(this.selfId(), roomId)
  }

  public async roomQRCode (roomId: string): Promise<string> {
    log.verbose(PRE, 'roomQRCode(%s)', roomId)

    await this.room.roomQrcode(this.selfId(), roomId)

    return new Promise((resolve) => {
      this.room.pushRoomQrcodeCallback(roomId, (qrcode: string) => {
        resolve(qrcode)
      })
    })
  }

  public async roomAnnounce (roomId: string)                : Promise<string>
  public async roomAnnounce (roomId: string, text: string)  : Promise<void>

  public async roomAnnounce (roomId: string, text?: string) : Promise<void | string> {
    log.silly(PRE, `roomAnnounce() room id: ${roomId}, text: ${text}`)
    if (text) {
      await this.room.setAnnouncement(this.selfId(), roomId, text)
    } else {
      throw new Error(`not supported get room announcement.`)
    }
  }

  /**
   *
   * Room Invitation
   *
   */
  public async roomInvitationAccept (roomInvitationId: string): Promise<void> {
    log.verbose(PRE, 'roomInvitationAccept(%s)', roomInvitationId)
    if (!this.cacheManager) {
      throw new Error(`no cache manager`)
    }
    const roomInvitation = await this.cacheManager.getRoomInvitation(roomInvitationId)
    if (roomInvitation && roomInvitation.url) {
      await this.room.getRoomInvitationDetail(roomInvitation.url)
    } else {
      throw new Error(`can not get room invitation by this id : ${roomInvitationId}`)
    }
  }

  public async roomInvitationRawPayload (roomInvitationId: string): Promise<MacproRoomInvitationPayload> {
    log.verbose(PRE, `roomInvitationRawPayload(${roomInvitationId})`)

    if (!this.cacheManager) {
      throw new Error('no cache')
    }

    const payload = await this.cacheManager.getRoomInvitation(roomInvitationId)

    if (payload) {
      return payload
    } else {
      throw new Error(`can not get invitation with invitation id: ${roomInvitationId}`)
    }
  }

  public async roomInvitationRawPayloadParser (rawPayload: MacproRoomInvitationPayload): Promise<RoomInvitationPayload> {
    log.silly(PRE, `roomInvitationRawPayloadParser()`)
    const payload: RoomInvitationPayload = {
      avatar: rawPayload.thumbUrl,
      id: rawPayload.id,
      invitation: rawPayload.url,
      inviterId: rawPayload.fromUser,
      memberCount: 0,
      memberIdList: [],
      receiverId: rawPayload.receiver,
      timestamp: rawPayload.timestamp,
      topic: rawPayload.roomName,
    }
    return payload
  }

  /**
   *
   * Friendship
   *
   */

  public async friendshipSearchPhone (phone: string): Promise<string | null> {
    throw new Error(`not supported ${phone}`)
  }

  public async friendshipSearchWeixin (weixin: string): Promise<string | null> {
    throw new Error(`not supported ${weixin}`)
  }

  public async friendshipRawPayload (friendshipId: string): Promise<FriendshipPayload> {
    if (!this.cacheManager) {
      throw new Error(`cache manager is not available, can not get friendship raw payload.`)
    }
    const rawPayload = await this.cacheManager.getFriendshipRawPayload(friendshipId)
    if (!rawPayload) {
      throw new Error(`no rawPayload for id ${friendshipId}`)
    }
    return rawPayload
  }

  public async friendshipRawPayloadParser (
    rawPayload: FriendshipPayload
  ) : Promise<FriendshipPayload> {
    return rawPayload
  }

  public async friendshipAdd (
    contactId : string,
    hello     : string,
  ): Promise<void> {
    log.verbose(PRE, 'friendshipAdd(%s, %s)', contactId, hello)

    if (!this.cacheManager) {
      throw CacheManageError('friendshipAdd()')
    }
    const contact = await this.cacheManager.getContact(contactId)
    const extend = this.selfId() + contactId

    if (contact) {
      await this.user.addFriend(this.selfId(), contact.accountAlias, hello)
    } else {
      await this.user.addFriend(this.selfId(), contactId, hello)
    }
    await new Promise<AddFriendBeforeAccept>(async (resolve) => {
      this.addFriendCB[extend] = (data: AddFriendBeforeAccept) => {
        resolve(data)
      }
    })
  }

  public async friendshipAccept (
    friendshipId : string,
  ): Promise<void> {
    log.verbose(PRE, 'friendshipAccept(%s)', friendshipId)

    if (!this.cacheManager) {
      throw CacheManageError('friendshipAccept()')
    }
    const friendshipPayload = await this.cacheManager.getFriendshipRawPayload(friendshipId)
    if (!friendshipPayload) {
      log.warn(`Can not find friendship payload, not able to accept friendship.`)
      return
    }
    await this.user.acceptFriend(this.selfId(), friendshipPayload.contactId)
  }

  public ding (data?: string): void {
    log.silly(PRE, 'ding(%s)', data || '')
    const eventDongPayload: EventDongPayload = {
      data: data ? data! : 'ding-dong',
    }
    this.emit('dong', eventDongPayload)
  }

  public unref (): void {
    log.verbose(PRE, 'unref()')
    super.unref()
    if (this.loopTimer) {
      this.loopTimer.unref()
    }
  }

}

export default PuppetMacpro
