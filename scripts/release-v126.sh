#!/bin/bash
set -e
cd /root/aitoapi-custom-repo
git add -A
git -c user.name=mulan777 -c user.email=mulan777@users.noreply.github.com commit -m "release: v1.2.6" --allow-empty
git tag -a v1.2.6 -m "v1.2.6: isolated AutoHeal probe + crash-loop blindspot fix"
git push origin main v1.2.6 2>&1 | tail -3
echo "---- remote tag verify ----"
git ls-remote origin refs/tags/v1.2.6
