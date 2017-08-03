import React from 'react'
import {findDOMNode} from 'react-dom'
import {FormattedMessage as _FM} from 'react-intl'
import classNames from 'classnames'
import {intlShape} from 'react-intl'
import {List} from 'immutable'

import {AppPropType, ContextPropType} from 'src/propTypes'
import {
  COLUMN_NOTIFICATIONS, SUBJECT_MIXED, MAX_STATUSES, AUTO_PAGING_MARGIN,
} from 'src/constants'
import {NotificationTimeline} from 'src/models/Timeline'
import NotificationListener from 'src/controllers/NotificationListener'
import TimelineNotification from 'src/pages/components/TimelineNotification'
import {NotificationTimelineLoader} from 'src/controllers/TimelineLoader'
import TimelineData from 'src/infra/TimelineData'
import TimelineActions from 'src/controllers/TimelineActions'
import TokenListener from 'src/controllers/TokenListener'
import {ColumnHeader, ColumnHeaderMenu, NowLoading} from 'src/pages/parts'
import {RefCounter} from 'src/utils'

/**
 * 通知カラム
 * TODO: TimelineColumnとのコピペなのを何とかする
 */
export default class NotificationColumn extends React.Component {
  static contextTypes = {
    app: AppPropType,
    context: ContextPropType,
    intl: intlShape,
  }

  constructor(...args) {
    super(...args)
    this.db = TimelineData
    this.scrollLockCounter = new RefCounter({
      onLocked: ::this.onLocked,
      onUnlocked: ::this.onUnlocked,
    })
    this.timeline = new NotificationTimeline(MAX_STATUSES)  // eslint-disable-line new-cap
    this.tokenListener = new TokenListener(this.props.subject, {
      onTokenAdded: ::this.onTokenAdded,
      onTokenRemoved: ::this.onTokenRemoved,
      onTokenUpdated: ::this.onTokenUpdated,
    })
    this.timelineListener = new NotificationListener(this.timeline, this.db)  // eslint-disable-line new-cap
    this.timelineLoaders = null
    this.actionDelegate = new TimelineActions(this.context)
    this.unlockScrollLock = null
    this.state = {
      ...this.getStateFromContext(),
      isMenuVisible: false,
      isScrollLocked: false,
      isTailLoading: false,
      loading: true,
      timeline: new List(),
    }

    // temporary
    this.listenerRemovers = []
  }

  get isMixedTimeline() {
    return this.props.subject === SUBJECT_MIXED
  }

  /**
   * @override
   */
  componentDidMount() {
    // update accounts
    const {context} = this.context

    this.listenerRemovers = [
      context.onChange(this.onChangeContext.bind(this)),
      this.timeline.onChange(this.onTimelineChanged.bind(this)),
      this.db.registerTimeline(this.timeline),
    ]

    // make event listener
    this.tokenListener.updateTokens(this.state.tokenState.tokens)
  }

  /**
   * @override
   */
  componentWillUnmount() {
    for(const remover of this.listenerRemovers) {
      remover()
    }

    if(this.subtimeline)
      this.db.decrement(this.subtimeline.uris)
    if(this.timeline)
      this.db.decrement(this.timeline.uris)

    this.subtimlineChangedRemover && this.subtimlineChangedRemover()
    this.timelineListener.clean()
  }

  /**
   * @override
   */
  render() {
    const {isLoading} = this.props

    return (
      <div className="column">
        <ColumnHeader
          canShowMenuContent={!isLoading}
          isPrivate={true}
          menuContent={this.renderMenuContent()}
          title={this.renderTitle()}
          onClickHeader={this.onClickHeader.bind(this)}
          onClickMenu={this.onClickMenuButton.bind(this)}
        />

        {isLoading
          ? <div className="column-body is-loading"><NowLoading /></div>
          : this.renderBody()
        }
      </div>
    )
  }


  // render


  renderTitle() {
    const {formatMessage} = this.context.intl

    if(this.isMixedTimeline) {
      return formatMessage({id: 'column.title.united_notifications'})
    } else {
      const {token} = this.state

      if(!token)
        return formatMessage({id: 'column.title.notifications'})

      return (
        <h1 className="column-headerTitle">
          <div className="column-headerTitleSub">{token.acct}</div>
          <div className="column-headerTitleMain"><_FM id="column.title.notifications" /></div>
        </h1>
      )
    }
  }

  renderMenuContent() {
    return <ColumnHeaderMenu isCollapsed={!this.state.isMenuVisible} onClickClose={this.props.onClose} />
  }

  renderBody() {
    const {timeline, loading, isTailLoading} = this.state

    return (
      <div className={classNames(
        'column-body',
        {'is-loading': loading}
      )}>
        <ul className="timeline" onScroll={::this.onTimelineScrolled} ref="timeline">
          {timeline.map((ref) => this.renderTimelineRow(ref))}
          {isTailLoading && <li className="timeline-loading"><NowLoading /></li>}
        </ul>
      </div>
    )
  }

  renderTimelineRow(ref) {
    const {subject} = this.props
    const {tokens} = this.state.tokenState

    return (
      <li key={ref.uri}>
        <TimelineNotification
          subject={subject !== SUBJECT_MIXED ? subject : null}
          notificationRef={ref}
          tokens={tokens}
          onLockStatus={() => this.scrollLockCounter.increment()}
          {...this.actionDelegate.props}
        />
      </li>
    )
  }


  // private


  makeLoaderForToken(timeline, token) {
    return new NotificationTimelineLoader(timeline, token, this.db)
  }

  loadMoreStatuses() {
    require('assert')(this.subtimeline)

    if(!this.timelineLoaders) {
      this.timelineLoaders = {}
      for(const token of this.tokenListener.getTokens()) {
        this.timelineLoaders[token.address] = {
          loader: this.makeLoaderForToken(this.subtimeline, token),
          loading: false,
        }
      }
    }

    for(const loaderInfo of Object.values(this.timelineLoaders)) {
      if(!loaderInfo.loading && !loaderInfo.loader.isTailReached()) {
        loaderInfo.loading = true
        loaderInfo.loader.loadNext()
          .then(() => {
            loaderInfo.loading = false
            this.updateLoadingStatus()
          }, (...args) => {
            console.log('loadNext failed: ', args)
            loaderInfo.loading = false
            this.updateLoadingStatus()
          })
      }
    }
    this.updateLoadingStatus()
  }

  updateLoadingStatus() {
    let isTailLoading = this.timelineLoaders &&
      !Object.values(this.timelineLoaders).every((loaderInfo) => !loaderInfo.loading)
    this.setState({isTailLoading})
  }


  // callbacks
  // scrollLockCounter callbacks
  onLocked() {
    this.subtimeline = this.timeline.clone()
    this.subtimeline.max = undefined
    this.subtimlineChangedRemover = this.subtimeline.onChange(::this.onSubtimelineChanged)
    this.db.registerTimeline(this.subtimeline)
    this.db.increment(this.subtimeline.uris)

    this.setState({
      isScrollLocked: true,
      timeline: this.subtimeline.timeline,
    })
  }

  onUnlocked() {
    this.db.decrement(this.subtimeline.uris)
    this.db.unregisterTimeline(this.subtimeline)
    this.subtimeline = null
    this.timelineLoaders = null
    this.subtimlineChangedRemover()
    this.subtimlineChangedRemover = null

    this.setState({
      isScrollLocked: false,
      timeline: this.timeline.timeline,
    })
  }

  /**
   * Timelineが更新されたら呼ばれる
   */
  onTimelineChanged() {
    if(this.state.isScrollLocked) {
      // スクロールがLockされていたらメインTimelineは更新しない
      // this.setState({
      //   loading: false,
      //   newTimeline: this.timeline,
      // })
    } else {
      // スクロールは自由なのでメインTimelineを直接更新する
      this.setState({
        loading: false,
        timeline: this.timeline.timeline,
      })
      // console.log('main', this.timeline.timeline.size)
    }
  }

  onSubtimelineChanged() {
    // load中にlock解除されたら、ここはnull
    if(!this.subtimeline)
      return
    this.setState({
      loading: false,
      timeline: this.subtimeline.timeline,
    })
  }

  // TokenListener callbacks
  onTokenAdded(newToken) {
    // install listener
    this.timelineListener.addListener(newToken.acct, newToken)

    // load timeline
    this.makeLoaderForToken(this.timeline, newToken).loadInitial()

    // TODO: なんだかなぁ
    if(this.isMixedTimeline)
      this.setState({token: this.tokenListener.getSubjectToken()})
  }

  onTokenRemoved(oldToken) {
    // remove listener
    this.timelineListener.removeListener(oldToken.acct)

    // TODO: remove statuses

    // TODO: なんだかなぁ
    if(this.isMixedTimeline)
      this.setState({token: this.tokenListener.getSubjectToken()})
  }

  onTokenUpdated(newToken, oldToken) {
    // update listener
    const {acct} = newToken

    this.timelineListener.removeListener(acct)
    this.timelineListener.addListener(acct, newToken)

    // TODO: なんだかなぁ
    if(this.isMixedTimeline)
      this.setState({token: this.tokenListener.getSubjectToken()})
  }

  // dom events
  /**
   * Timelineがスクロールしたら呼ばれる。Lockとかを管理
   * @param {Event} e
   */
  onTimelineScrolled(e) {
    const node = e.target
    const {clientHeight, scrollHeight, scrollTop} = node
    const loadMoreThreshold = scrollHeight - AUTO_PAGING_MARGIN

    // Scroll位置がちょっとでもTopから動いたらLockしちゃう
    if(!this.unlockScrollLock && scrollTop > 0) {
      // Scrollが上部以外になったのでScrollをLockする
      require('assert')(!this.unlockScrollLock)
      this.unlockScrollLock = this.scrollLockCounter.increment()
    } else if(this.unlockScrollLock && scrollTop <= 0) {
      // Scrollが上部になったのでScrollをUnlockする
      this.unlockScrollLock()
      this.unlockScrollLock = undefined
    }

    if(loadMoreThreshold <= clientHeight)
      return

    // Scroll位置がBottomまであとちょっとになれば、次を読み込む
    if(scrollTop + clientHeight > loadMoreThreshold) {
      //
      if(!this.state.isTailLoading) {
        this.loadMoreStatuses()
      }
    }
  }

  onClickHeader() {
    const {column, onClickHeader} = this.props
    const node = findDOMNode(this)
    const scrollNode = findDOMNode(this.refs.timeline)

    if(node instanceof HTMLElement) {
      if(scrollNode && scrollNode instanceof HTMLElement) {
        onClickHeader(column, node, scrollNode)
      } else {
        onClickHeader(column, node, undefined)
      }
    }
  }

  onClickMenuButton(e) {
    e.stopPropagation()
    this.setState({isMenuVisible: !this.state.isMenuVisible})
  }


  // temporary


  onChangeContext(changingStores) {
    this.setState(this.getStateFromContext())

    // なんだかなあ
    const {tokenState} = this.context.context.getState()
    this.tokenListener.updateTokens(tokenState.tokens)

    if(!this.isMixedTimeline) {
      this.setState({token: tokenState.getTokenByAcct(this.props.subject)})
    }
  }

  getStateFromContext() {
    const {context} = this.context
    return context.getState()
  }
}
require('./').registerColumn(COLUMN_NOTIFICATIONS, NotificationColumn)
