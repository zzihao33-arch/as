import os, sys, subprocess
stage='/root/cmhub-push-logs-20260917-ca05db3'
os.chdir('/www/server/panel')
sys.path.insert(0,'/www/server/panel/class')
import public
env={'PATH':'/www/server/nodejs/v20.10.0/bin:/usr/bin:/bin','HOME':'/root','DBA_PASSWORD':public.M('config').where('id=?',(1,)).getField('mysql_root')}
try:
    result=subprocess.run(['/www/server/nodejs/v20.10.0/bin/node',stage+'/deploy-server.mjs'],cwd=stage,env=env,timeout=120)
    sys.exit(result.returncode)
finally:
    env.pop('DBA_PASSWORD',None)
