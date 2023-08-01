// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CalendarUnit} from "../SharedDefs.sol";

// a CreditConfig is created after approval
struct CreditConfig {
    uint96 creditLimit;
    uint96 committedAmount;
    CalendarUnit calendarUnit; // days or semimonth
    uint16 periodDuration;
    uint16 numOfPeriods; // number of periods
    // Yield in BPs, mean different things for different credit types.
    // For credit line, it is APR;
    // for factoring, it is factoring fee for the given period;
    // for dynamic yield credit, it is the estimated APY
    uint16 yieldInBps;
    bool revolving; // if repeated borrowing is allowed
    bool receivableBacked; // if the credit is receivable-backed
    bool borrowerLevelCredit; // borrower-level vs receivable-level
    bool exclusive; // if the credit pool exclusive to a borrower
}

// a CreditRecord is created after the first drawdown
struct CreditRecord {
    uint96 unbilledPrincipal;
    uint64 nextDueDate; // the due date of the next payment
    uint96 totalDue; // the due amount of the next payment
    uint96 yieldDue; // yield and fees due for the next payment
    uint96 feesDue;
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

enum ReceivableState {
    Deleted,
    Minted,
    Approved,
    PartiallyPaid,
    Paid,
    Rejected,
    Delayed,
    Defaulted
}

enum PaymentStatus {
    NotReceived,
    ReceivedNotVerified,
    ReceivedAndVerified
}

struct ReceivableInfo {
    // The total expected payment amount of the receivable
    uint96 receivableAmount;
    // The amount of the receivable that has been paid so far
    uint64 creationDate;
    // The date at which the receivable is expected to be fully paid
    uint96 paidAmount;
    // The ISO 4217 currency code that the receivable is denominated in
    uint16 currencyCode;
    // The date at which the receivable is created
    uint64 maturityDate;
    ReceivableState state;
}

struct FacilityConfig {
    // Percentage of receivable nominal amount to be available for drawdown.
    uint16 advanceRateInBps;
    uint96 committedCreditLine;
    bool autoApproval;
}

struct PnLTracker {
    uint96 profitRate;
    uint96 lossRate;
    uint64 pnlLastUpdated;
    uint96 totalProfit;
    uint96 totalLoss;
    uint96 totalLossRecovery;
}
