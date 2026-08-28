@echo off
rem 自动抓取多类别每日简报（投资 / 科研 / web3 / 科技）并推送
rem 需本地已配置 git 远程与凭据；不加 --push 则只生成 digest.json
cd /d "%~dp0"
"C:\Users\admin\.workbuddy\binaries\python\versions\3.13.12\python.exe" fetch_digest.py --push
