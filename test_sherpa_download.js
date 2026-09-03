// 從 index.html 抽出 fetchRange / downloadInChunks，用假 fetch 驗證分段與重試
const fs=require('fs'), assert=require('assert');
const html=fs.readFileSync(`${__dirname}/index.html`,'utf8');
const src=[/const CHUNK_BYTES = [^\n]*\n/, /async function fetchRange\([\s\S]*?\n  \}\n/,
           /async function downloadInChunks\([\s\S]*?\n  \}\n/, /async function streamWhole\([\s\S]*?\n  \}\n/]
  .map(re=>html.match(re)[0]).join('\n');

const TOTAL=20*1024*1024;
const full=Buffer.alloc(TOTAL); for(let i=0;i<TOTAL;i++) full[i]=i&0xff;

function makeFetch({failAt=[], noRange=false}={}) {
  const calls={n:0, ranges:[]};
  const f = async (url, opts={}) => {
    calls.n++;
    const r=(opts.headers||{}).Range;
    if (noRange) return {ok:true,status:200,headers:{get:k=>k==='Content-Length'?String(TOTAL):null},
      body:{getReader(){let sent=false;return{read:async()=>sent?{done:true}:(sent=true,{done:false,value:new Uint8Array(full)})}}}};
    const m=r.match(/bytes=(\d+)-(\d+)/); const [s,e]=[+m[1],+m[2]];
    if (failAt.includes(calls.n)) throw new TypeError('network error');
    return {ok:true,status:206,
      headers:{get:k=>k==='Content-Range'?`bytes ${s}-${e}/${TOTAL}`:null},
      arrayBuffer:async()=>full.buffer.slice(s,e+1)};
  };
  return [f, calls];
}

async function run(opts) {
  const [fetchStub, calls]=makeFetch(opts);
  const ctx={fetch:fetchStub, setSherpaProgress:()=>{}, setTimeout:(fn)=>fn()};
  const out=await new Function('fetch','setSherpaProgress','setTimeout',
    `${src}; return downloadInChunks('u');`)(ctx.fetch,ctx.setSherpaProgress,ctx.setTimeout);
  return [Buffer.from(out.buffer||out), calls];
}

(async () => {
  let [got]=await run();
  assert.strictEqual(got.length, TOTAL, '長度應等於總大小');
  assert(got.equals(full), '分段組回來的內容必須與原檔一致');

  // 第 3 次請求失敗（probe 是第 1 次），重試後仍須組出正確內容
  [got]=await run({failAt:[3]});
  assert(got.equals(full), '單段失敗重試後內容仍須正確');

  // 同一段連續失敗 3 次仍在重試上限內
  [got]=await run({failAt:[3,4,5]});
  assert(got.equals(full), '同段連續失敗 3 次仍應成功');

  // 超過重試上限應拋出，而不是回傳半截資料
  await assert.rejects(run({failAt:[3,4,5,6]}), /network error/, '超過上限應拋錯');

  // 伺服器不支援 Range 時退回整份串流
  [got]=await run({noRange:true});
  assert(got.equals(full), '不支援 Range 時應退回 streamWhole 且內容正確');

  console.log('downloadInChunks: 5 checks passed');
})();
