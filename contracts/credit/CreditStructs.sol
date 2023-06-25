// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

struct CreditConfig {
    uint8 scheduleOption; // interval schedule, calendar schedule(week, month, quater)
    uint16 periodCount; // number of periods
    uint16 intervalDays; // the duraion of one period in days, it is only used for interval option
    uint8 paymentOption; // bullet, interest/principal, Amortization
    uint16 aprInBps;
}