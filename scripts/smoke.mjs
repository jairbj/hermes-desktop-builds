import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';

const [source,binary,home,logs]=process.argv.slice(2);
assert(source&&binary&&home&&logs,'Usage: smoke.mjs source binary isolatedHome logs');
const require=createRequire(path.join(source,'apps/desktop/package.json'));
const {_electron}=require('playwright');
assert.equal(fs.existsSync(path.join(home,'.hermes')),false,'Smoke HOME must be fresh');
const env={...process.env};
env.PATH=process.platform==='win32'?path.join(env.SystemRoot||env.SYSTEMROOT||'C:\\Windows','System32'):'/usr/bin:/bin:/usr/sbin:/sbin';
const args=['--user-data-dir='+path.join(home,'u'),'--enable-logging=stderr'];
// Linux CI only: no host kernel/security changes; never Mac/Windows install advice.
if(process.platform==='linux'){delete env.DISPLAY;delete env.XAUTHORITY;args.push('--disable-gpu','--no-sandbox','--ozone-platform=headless');}
function smokeLog(message){fs.writeSync(1,message+'\n');}
function packagedResources(binary){
  return process.platform==='darwin'
    ? path.resolve(path.dirname(binary),'..','Resources')
    : path.join(path.dirname(binary),'resources');
}
// Playwright's ElectronApplication.evaluate has no timeout: it waits on a
// node-inspector handle that does not settle for this packaged Electron.
// node-pty still has to load from the packaged asar, so the probe is a second
// process of the same binary with Electron's node mode.
function runPackagedPty(binary,appAsar,logs){
  const entry=path.join(appAsar,'dist','electron-main.mjs');
  const probe=path.join(logs,'pty-probe.cjs');
  const resultPath=path.join(logs,'pty-result.json');
  const win=process.platform==='win32';
  const shell=win?(process.env.ComSpec||process.env.COMSPEC||'C:\\Windows\\System32\\cmd.exe'):'/bin/sh';
  const args=win?['/d','/c','echo HERMES_NATIVE_PTY_OK']:['-c','printf HERMES_NATIVE_PTY_OK'];
  fs.writeFileSync(probe,`const fs=require('fs');
const {createRequire}=require('module');
const resultPath=process.env.HERMES_PTY_RESULT;
function finish(payload,code){
  fs.writeFileSync(resultPath,JSON.stringify(payload));
  process.exit(code);
}
try {
  const pty=createRequire(${JSON.stringify(entry)})('node-pty');
  const t=pty.spawn(${JSON.stringify(shell)},${JSON.stringify(args)},{name:'xterm',cols:80,rows:24,cwd:process.env.HOME||process.cwd(),env:{...process.env}});
  let output='';
  const timer=setTimeout(()=>{try{t.kill();}catch(e){} finish({exitCode:null,output,error:'PTY timeout'},2);},15000);
  t.onData(s=>{output+=s;});
  t.onExit(({exitCode})=>{
    clearTimeout(timer);
    const ok=exitCode===0&&output.includes('HERMES_NATIVE_PTY_OK');
    finish({exitCode,output},ok?0:1);
  });
} catch(error){
  finish({exitCode:1,output:'',error:String(error&&error.stack||error)},1);
}
`);
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,[probe],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HERMES_PTY_RESULT:resultPath},stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stderr='';
    child.stderr.on('data',d=>{stderr+=d;});
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('PTY probe timed out: '+stderr.slice(-800)));},20000);
    child.on('exit',code=>{
      clearTimeout(timer);
      let payload=null;
      try{payload=JSON.parse(fs.readFileSync(resultPath,'utf8'));}catch(e){}
      if(code===0&&payload){resolve(payload);return;}
      reject(new Error('PTY probe failed with exit '+code+': '+(payload&&payload.error?payload.error+' ':'')+stderr.slice(-800)));
    });
  });
}
const smokeDeadline=setTimeout(()=>{smokeLog('SMOKE_TIMEOUT');process.exit(1);},280000);
const errors=[];
let app;
try {
  smokeLog('SMOKE_STEP launch');
  app=await _electron.launch({executablePath:binary,args,env,timeout:90000});
  smokeLog('SMOKE_STEP firstWindow');
  const page=await app.firstWindow({timeout:90000});
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);
  page.on('pageerror',err=>errors.push(String(err)));
  smokeLog('SMOKE_STEP heading');
  await page.getByRole('heading',{name:'Connect to existing Hermes',exact:true}).waitFor({timeout:90000});
  smokeLog('SMOKE_STEP placeholder');
  await page.getByPlaceholder('https://gateway.example.com/hermes').waitFor({timeout:90000});
  assert.equal(await page.getByText('Install Hermes locally',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Back',exact:true}).count(),0);
  fs.writeFileSync(path.join(logs,'first-run.txt'),await page.locator('body').innerText());
  smokeLog('SMOKE_STEP stamp');
  const resources=packagedResources(binary);
  const appAsar=path.join(resources,'app.asar');
  assert.equal(fs.existsSync(appAsar),true,'Packaged app.asar missing');
  const hermesHome=path.join(home,'.hermes');
  const desktopLogPath=path.join(hermesHome,'logs','desktop.log');
  assert.equal(fs.existsSync(desktopLogPath),true,'packaged app did not write desktop.log');
  const desktopLog=fs.readFileSync(desktopLogPath,'utf8');
  assert(desktopLog.includes(hermesHome)||desktopLog.includes(hermesHome.replaceAll('\\','/')),'packaged app did not log its HERMES_HOME');
  const paths={packaged:true,resources,appAsar,hermesHome,platform:process.platform,arch:process.arch};
  const installStamp=JSON.parse(fs.readFileSync(path.join(resources,'install-stamp.json'),'utf8'));
  const sourceDesktopVersion=JSON.parse(fs.readFileSync(path.join(source,'apps/desktop/package.json'),'utf8')).version;
  assert.match(sourceDesktopVersion,/^\d+(?:\.\d+)+$/);
  smokeLog('SMOKE_STEP version');
  const runtimeDesktopVersionInfo=await page.evaluate(()=>window.hermesDesktop.getVersion());
  assert.equal(typeof runtimeDesktopVersionInfo,'object');
  assert.equal(typeof runtimeDesktopVersionInfo.appVersion,'string');
  const runtimeDesktopVersion=runtimeDesktopVersionInfo.appVersion;
  if(process.platform==='darwin'){
    assert.equal(installStamp.distribution,'frankhommers-homebrew');
    assert.match(installStamp.distributionVersion,/^\d+(?:\.\d+)+$/);
    assert.equal(runtimeDesktopVersion,installStamp.distributionVersion);
  }else{
    assert.equal(installStamp.distribution,'desktop-app');
    if(sourceDesktopVersion==='0.0.0'){
      assert.match(runtimeDesktopVersion,/^\d+(?:\.\d+)+$/);
    }else{
      assert.equal(runtimeDesktopVersion,sourceDesktopVersion);
    }
  }

  fs.writeFileSync(path.join(logs,'remote-form.txt'),await page.locator('body').innerText());
  smokeLog('SMOKE_STEP bootstrap');
  const bootstrap=await page.evaluate(()=>window.hermesDesktop.getBootstrapState());
  assert.equal(bootstrap.active,false);
  assert.equal(bootstrap.manifest,null);
  assert.deepEqual(bootstrap.stages,{});
  assert(bootstrap.setupChoice,'No local installation started');
  const guard=createServer();
  await new Promise(resolve=>guard.listen(0,'127.0.0.1',resolve));
  const port=guard.address().port;
  await new Promise(resolve=>guard.close(resolve));
  smokeLog('SMOKE_STEP fill');
  await page.getByPlaceholder('https://gateway.example.com/hermes').fill(`http://127.0.0.1:${port}`,{timeout:20000,force:true});
  const test=page.getByRole('button',{name:'Test connection',exact:true});
  smokeLog('SMOKE_STEP test-connection');
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Test connection'&&!b.disabled),undefined,{timeout:90000});
  await test.click({timeout:20000,force:true});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Test connection'&&!b.disabled),undefined,{timeout:90000});
  const remoteProbe=await page.evaluate(url=>window.hermesDesktop.probeConnectionConfig(url),`http://127.0.0.1:${port}`);
  assert.equal(remoteProbe.reachable,false);
  assert(remoteProbe.error,'Actual native IPC/network probe must return an error');
  assert.equal(await page.getByRole('button',{name:'Apply and reconnect',exact:true}).isDisabled(),true);
  fs.writeFileSync(path.join(logs,'unreachable-remote.txt'),await page.locator('body').innerText());
  smokeLog('SMOKE_STEP pty');
  const ptyResult=await runPackagedPty(binary,appAsar,logs);
  assert.equal(ptyResult.exitCode,0);
  assert(ptyResult.output.includes('HERMES_NATIVE_PTY_OK'));
  const after=await page.evaluate(()=>window.hermesDesktop.getBootstrapState());
  assert.equal(after.active,false);assert.deepEqual(after.stages,{});
  assert(!fs.existsSync(path.join(home,'.hermes/hermes-agent')),'No local agent checkout');
  assert.equal(errors.length,0,JSON.stringify(errors));
  const result={platform:process.platform,arch:process.arch,paths,installStamp,sourceDesktopVersion,runtimeDesktopVersionInfo,runtimeDesktopVersion,firstRun:true,remoteForm:true,remoteSetupDirect:true,localInstallOfferAbsent:true,unreachableRemoteBlocksApply:true,bootstrap,ptyResult,errors,noAgentCheckout:true,localInstallStarted:false};
  fs.writeFileSync(path.join(logs,'smoke.json'),JSON.stringify(result,null,2)+'\n');
  smokeLog('REAL NATIVE PACKAGED APP SMOKE: '+JSON.stringify(result));
} catch(error){
  smokeLog('SMOKE_FAIL '+(error&&error.stack?error.stack:error));
  throw error;
} finally {
  clearTimeout(smokeDeadline);
  if(app){
    smokeLog('SMOKE_STEP close');
    const closed=await Promise.race([
      app.close().then(()=>true,()=>false),
      new Promise(resolve=>setTimeout(()=>resolve(false),20000)),
    ]);
    if(!closed){
      smokeLog('SMOKE_CLOSE_TIMEOUT');
      try{app.process().kill('SIGKILL');}catch{}
    }
  }
}
