// Guard an already prepared private reply, never inspect/interpret message text.
export function privateReplyGuard({key,sameActor,state,readThrough}) {
  if(!/^private:\d+$/.test(key)||!sameActor)return ()=>{}
  const captured=state(),latest=Number(captured.lastUnreadSeq)||0
  const initiallyUnseen=readThrough(captured)<latest
  return ()=>{
    const current=state()
    if(current!==captured||initiallyUnseen||(Number(current.lastUnreadSeq)||0)>latest){
      const e=new Error('对方有新消息，旧回复尚未发送的部分已取消。先读取本聊天新增消息，再决定怎样回应；不要原样重试旧回复，也不要重复已经发送的部分。')
      e.code='NEW_PRIVATE_INPUT';throw e
    }
  }
}
