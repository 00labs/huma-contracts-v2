// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CalendarUnit} from "../SharedDefs.sol";

// a CreditConfig is created after approval
struct CreditConfig {
    uint96 creditLimit;
    CalendarUnit calendarUnit; // days or semimonth
    uint16 periodDuration;
    uint16 numOfPeriods; // number of periods
    // Yield in BPs, mean different things for different credit types.
    // For credit line, it is APR;
    // for factoring, it is factoring fee for the given period;
    // for dynamic yield credit, it is the estimated APY
    uint16 yieldInBps;
    bool revolving; // whether repeated borrowing is allowed
    bool receivableRequired;
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
    bool revolving; // whether repeated borrowing is allowed
    address borrower;
    uint96 availableCredit;
}

struct CreditProfit {
    uint96 totalAccruedProfit; // total accrued interest from tha loan start
    uint64 lastProfitUpdateDate;
}

struct CreditLoss {
    uint96 totalAccruedLoss;
    uint64 lastLossUpdateDate;
}

struct CreditLimits {
    uint96 creditLimit;
    uint96 availableCredit;
}

enum CreditState {
    Deleted,
    Requested,
    Approved,
    GoodStanding,
    Delayed,
    Defaulted
}

struct ReceivableInfo {
    address receivableAsset;
    uint96 receivableAmount;
    uint256 receivableId;
}

struct FacilityConfig {
    // Percentage of receivable nominal amount to be available for drawdown.
    uint16 advanceRateInBps;
    uint96 committedCreditLine;
    bool autoApproval;
}
