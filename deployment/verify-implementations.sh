#!/bin/bash
jq -r '.[]' $1 | while read implementation; do
  echo "Verifying implementation: $implementation"
  yarn hardhat verify --network $2 $implementation
done

