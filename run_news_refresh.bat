@echo off
rem 自动抓取 AI 资讯并推送（需本地已配置 git 远程与凭据）
cd /d "%~dp0"
"C:\Users\admin\.workbuddy\binaries\python\versions\3.13.12\python.exe" fetch_news.py --push
