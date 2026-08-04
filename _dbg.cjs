const path=require("path"),os=require("os"),fs=require("fs");
(async()=>{
  const EP=require("embedded-postgres"); const E=EP.default||EP;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dbg-"));const port=57902;
  const h=new E({databaseDir:dir,user:"postgres",password:"postgres",port,persistent:false});
  await h.initialise();await h.start();await h.createDatabase("matrix_test");
  process.env.DATABASE_URL=`postgres://postgres:postgres@127.0.0.1:${port}/matrix_test`;
  const db=require("./db.js");await db.initDb();
  const uk="dbg_"+Date.now(),ts0=1700000200000;
  for(const id of ["a","b","c"]) { const r=await db.recordFill(uk,{fillId:id,real:true,broker:"fyers",orderId:"OC",qty:1,fees:0,ts:ts0}); console.log("recordFill",id,JSON.stringify(r)); }
  const set=await db.getReconcilableFills(uk,0,ts0+100);
  console.log("reconcilable count",set.length, set.map(f=>f.fillId));
  await h.stop();process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
