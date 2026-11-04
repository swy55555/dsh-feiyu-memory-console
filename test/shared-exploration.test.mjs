import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedVideo,shareBvid,inboxState,enqueueShare,nextSharedPick,independentEvidence,optionalChoices,shareRecall,shareTurn} from '../bridge/owner-interest.mjs';
import {recentExplorePresence} from '../bridge/explore.mjs';
const ref='BV1234567890',url='https://www.bilibili.com/video/'+ref;
test('direct and card links separate owner intent from publisher text',async()=>{
 const card={type:'json',data:{data:JSON.stringify({meta:{detail_1:{qqdocurl:url,desc:'真好看'}}})}};
 assert.equal(sharedVideo([card]).ref,ref);
 assert.equal(sharedVideo([card,{type:'text',data:{text:'帮我看看真假'}}]).suggest,false);
 assert.equal(sharedVideo([card,{type:'text',data:{text:'别打开'}}]),null);
 for(const bad of [url.replace('.com','.com.bad'),url+'?p=2','https://evil.invalid/'+ref])assert.equal(sharedVideo(bad),null);
 const get=async(input,options)=>{assert.equal(options.redirect,'manual');assert.equal(options.headers,undefined);return new Response(null,{status:302,headers:{location:url}});};
 assert.equal(await shareBvid('https://b23.tv/a123',AbortSignal.timeout(5000),get),ref);
 await assert.rejects(shareBvid('https://b23.tv/a123',AbortSignal.timeout(5000),async()=>new Response(null,{status:302,headers:{location:'https://evil.invalid'}})));
 const inbox=inboxState();assert.ok(enqueueShare(inbox,sharedVideo(url)));assert.equal(enqueueShare(inbox,sharedVideo(url+'?foo=bar')),false);assert.equal(inbox.items.length,1);
 assert.match(shareRecall(inbox.items,'我分享给你的视频看了吗'),/尚无成功读取/);
});
test('temporary owner and shared suggestions are bounded and separate from taste',()=>{
 const state={topics:[{topic:'木工',strength:.3}]},copy=structuredClone(state),inbox={offers:[{topic:'观鸟',left:3}]},rows=[{topic:'露营',left:3,seen:true}];
 assert.equal(nextSharedPick(state,rows,inbox,[],()=>0).pick.basis,'shared-topic');
 const values=[.3,.01];assert.equal(nextSharedPick(state,rows,inbox,[],()=>values.shift()).pick.basis,'owner-introduction');
 assert.notEqual(nextSharedPick(state,[{topic:'观鸟',declined:true}],inbox,[],()=>0).pick.topic,'观鸟');
 assert.deepEqual(state,copy);
});
test('unresolved interests can be offered once, repeated reminders and owner-sourced reads cannot promote',()=>{
 const now=Date.now(),day=86400000,note={detail:'折角',question:'怎么折角？'},view={bvid:'B',author:'B'};
 const run={ok:true,contentRead:true,at:now-2*day,basis:'taste',note,video:{bvid:'A',author:'A'}};
 assert.equal(optionalChoices({items:[]},[run],now).past,run);
 assert.equal(optionalChoices({items:[]},[run,{consideredQuestion:'A'}],now).past,undefined);
 for(const basis of ['owner-share','question-followup','focus','shared-topic','owner-introduction'])assert.equal(independentEvidence([run],note,basis,view,now),null);
 assert.equal(independentEvidence([run],note,'taste',view,now),run);
 assert.equal(independentEvidence([run],note,'taste',run.video,now),undefined);
});
test('recall finds older relevant subtitles and aliases and ignores unrelated topics',()=>{
 const now=Date.now(),run={ok:true,contentRead:true,at:now,topic:'露营',video:{title:'雨天撤营',url},impressions:[{quote:'把湿面向内折起。'}],note:{aliases:['拔营']}};
 const runs=[run,{...run,topic:'木工',video:{title:'榫头',url:url+'B'},note:null,impressions:[]}];
 assert.match(recentExplorePresence({runs},{query:'拔营时往哪边叠？',now}),/湿面向内/);
 assert.equal(recentExplorePresence({runs},{query:'又冷又累，拔营真辛苦。',now}),'');
 assert.equal(recentExplorePresence({runs},{query:'拔营时往哪边叠？',now,selfItems:[{sourceUrl:url,sourceState:'invalid'}]}),'');
 assert.match(recentExplorePresence({runs},{query:'外层该怎么收？',now,semantic:[{sourceUrl:url,excerpt:'把湿面向内折起。'}]}),/雨天撤营/);
});
test('shared shorthand resolves unique titles and does not guess unknown or ambiguous references',()=>{
 const first={title:'雨中收帐篷',ref,bvid:ref,status:'read'},last={title:'水彩调色',ref:'BV0987654321',status:'pending'};
 const q=name=>'我分享的'+name+'那个你看了吗？';
 assert.match(shareRecall([first,last],q('帐篷')),/雨中收帐篷.*已成功读取/);
 assert.match(shareRecall([first,last],q('水彩')),/水彩调色.*尚无成功读取/);
 assert.match(shareRecall([first,last],q('煮粥')),/没能定位/);
 assert.match(shareRecall([first,{...last,title:'搭帐篷'}],q('帐篷')),/有多条/);
 assert.match(shareRecall([first,last],q(ref)),/已成功读取/);
 assert.match(shareRecall([first,last],q('BV1111111111')),/没能定位/);
 assert.match(shareRecall([first,last],'我分享的最后一条视频你看了吗？'),/水彩调色/);
 assert.equal(shareRecall([first,last],'我分享的帐篷你看到是多少钱？'),'');
});
test('equivalent attention preserves agency, directed operations and independent roots',()=>{
 const now=Date.now(),view={bvid:'new',author:'乙'};
 const earlier={at:now-86400000,ok:true,contentRead:true,basis:'taste',note:{detail:'布边折角'},video:{bvid:'old',author:'甲'}};
 const match=(a,b,opts={})=>independentEvidence([{...earlier,note:a,...opts}],b,'taste',view,now);
 assert.ok(match(earlier.note,{detail:'折布边角'}));
 assert.ok(match({detail:'织物收纳',detailAliases:['布料整理']},{detail:'布料整理',detailAliases:['织物收纳']}));
 assert.ok(!match({detail:'向内折',detailAliases:['向外折']},{detail:'向外折',detailAliases:['向内折']}));
 assert.ok(!match({detail:'先剪再折'},{detail:'先折再剪'}));
 assert.ok(!match({detail:'猫追狗'},{detail:'狗追猫'}));
 assert.ok(!match({detail:'织物收纳',aliases:['木工']},{detail:'木工'}));
 assert.ok(!match(earlier.note,{detail:'折布边角'},{at:now-1}));
 assert.ok(!match(earlier.note,{detail:'折布边角'},{basis:'owner-share'}));
});
test('attribute questions require supporting excerpts, including after a vector match',()=>{
 const now=Date.now(),video={title:'露营帐篷',url};
 const read=(query,quotes,semantic=[])=>recentExplorePresence({runs:[{ok:true,contentRead:true,at:now,video,topic:'帐篷',impressions:quotes.map(quote=>({quote}))}]},{now,query,semantic});
 assert.equal(read('帐篷多少钱？',['先把湿面收起。']), '');
 assert.equal(read('帐篷多少钱？',['运费是10元。']), '');
 assert.equal(read('帐篷多少钱？',['这次没提到价格。'],[{sourceUrl:url,excerpt:'把帐篷装袋。'}]),'');
 assert.equal(read('帐篷多少钱？',['这顶帐篷不是200元。']), '');
 assert.match(read('帐篷多少钱？',['先擦帐篷。','帐篷售价是299元。']),/299元/);
 assert.match(read('帐篷多重？',['外帐重1.8公斤。']),/1.8公斤/);
 assert.equal(read('帐篷多重？',['帐篷长2米。']), '');
 assert.equal(read('帐篷在哪家店买的？',['帐篷售价299元。']), '');
 assert.match(read('帐篷在哪家店买的？',['帐篷购自山野旗舰店。']),/山野旗舰店/);
 assert.equal(read('收帐篷要多长时间？',['帐篷长2米。']), '');
 assert.match(read('收帐篷要多长时间？',['我们收帐篷用了15分钟。']),/15分钟/);
});

test('immediate reads require an explicit owner request and an identifiable target',()=>{
 const a={ref,title:'雨停以后收外帐',status:'pending'},b={ref:'BV0987654321',title:'水彩调色',status:'pending'};
 assert.equal(shareTurn([a,b],'那现在就去看，回来告诉我她用什么颜色的袋子。',ref).matches[0],a);
 assert.equal(shareTurn([a,b],'现在去看《水彩调色》',ref).matches[0],b);
 assert.equal(shareTurn([a,b],'那现在就去看').matches.length,0);
 assert.equal(shareTurn([a,b],'现在去看那条视频').matches.length,0);
 for(const q of ['不要现在去看','她说“现在就去看”','现在去看医生','现在去看《水彩调色》可以吗？','如果你现在去看呢？'])assert.equal(shareTurn([a,b],q,ref),null,q);
});
test('content and status queries expose only the matching valid receipt',()=>{
 const row={ref,bvid:ref,title:'雨停以后收外帐',status:'read'},q='我分享的《雨停以后收外帐》你读到什么了？';
 const run={ok:true,contentRead:true,video:{bvid:ref,url},impressions:[{quote:'把外帐单独放进灰色网袋。'}]};
 assert.match(shareRecall([row],q,{runs:[run]}),/灰色网袋/);
 assert.match(shareRecall([row],'那读到什么了？',{recentRef:ref,runs:[run]}),/灰色网袋/);
 assert.doesNotMatch(shareRecall([row],q,{runs:[run],selfItems:[{sourceUrl:url,sourceState:'invalid'}]}),/灰色网袋/);
 assert.doesNotMatch(shareRecall([row],'我分享的视频看了吗？',{runs:[run]}),/灰色网袋/);
 assert.doesNotMatch(shareRecall([{...row,status:'pending'}],q,{runs:[run]}),/灰色网袋/);
});
