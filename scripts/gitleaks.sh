#!/bin/bash

git clone https://github.com/gitleaks/gitleaks.git
cd gitleaks
make build
cd ..
./gitleaks/gitleaks detect --verbose
rm -rf gitleaks
