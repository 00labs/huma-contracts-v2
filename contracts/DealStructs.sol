// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

struct DealConfig {
    uint8 scheduleOption;
    uint16 periodCount;
    uint16 intervalDays;
    uint8 paymentOption;
    uint16 aprInBps;
}
