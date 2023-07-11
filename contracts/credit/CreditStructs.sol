// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

struct CreditConfig {
    uint8 periodType;
    uint8 periodDuration;
    uint16 numOfPeriods; // number of periods
    uint16 yieldInBps;
    uint96 creditLimit;
}

struct CreditRecord {
    uint96 unbilledPrincipal;
    uint64 nextDueDate; // the due date of the next payment
    uint96 totalDue; // the due amount of the next payment
    uint96 feesAndInterestDue; // interest and fees due for the next payment
    uint16 missedPeriod;
    uint16 remainingPeriods;
    CreditState state;
    address borrower;
}

struct CreditProfit {
    uint96 totalAccruedProfit; // total accrued interest from tha loan start
    uint64 lastProfitUpdateDate;
}

struct CreditLoss{
    uint96 totalAccruedLoss;
    uint64 lastLossUpdateDate;
}

enum CreditState {
    Deleted,
    Requested,
    Approved,
    GoodStanding,
    Delayed,
    Defaulted
}
