// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CalendarUnit} from "../SharedDefs.sol";

// a CreditConfig is created after approval
struct CreditConfig {
    CalendarUnit calendarUnit;
    uint8 periodDuration;
    uint16 numOfPeriods; // number of periods
    uint16 apyInBps;
    bool revolving;
    uint96 creditLimit;
    address borrower;
}

// a CreditRecord is created after the first drawdown
struct CreditRecord {
    uint96 unbilledPrincipal;
    uint64 nextDueDate; // the due date of the next payment
    uint96 totalDue; // the due amount of the next payment
    uint96 feesAndInterestDue; // interest and fees due for the next payment
    uint16 missedPeriods;
    uint16 remainingPeriods;
    CreditState state;
    address borrower;
}

struct CreditProfit {
    uint96 totalAccruedProfit; // total accrued interest from tha loan start
    uint64 lastProfitUpdateDate;
}

struct CreditLoss {
    uint96 totalAccruedLoss;
    uint64 lastLossUpdateDate;
}

struct LimitAndCommitment {
    uint96 creditLimit;
    uint96 creditCommitment;
}

enum CreditState {
    Deleted,
    Requested,
    Approved,
    GoodStanding,
    Delayed,
    Defaulted
}
