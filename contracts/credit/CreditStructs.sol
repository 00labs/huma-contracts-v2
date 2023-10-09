// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CalendarUnit} from "../SharedDefs.sol";

// a CreditConfig is created after approval
struct CreditConfig {
    uint96 creditLimit;
    uint96 committedAmount;
    CalendarUnit calendarUnit; // day or month
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
    uint96 yieldDue; // yield due for the next payment
    uint96 feesDue; // fees due for the next payment
    uint16 missedPeriods; // the number of consecutive missed payments, for default processing
    uint16 remainingPeriods; // the number of payment periods until the maturity of the credit line
    CreditState state;
    // bool revolving; // whether repeated borrowing is allowed
}

struct CreditLimit {
    uint96 creditLimit;
    uint96 availableCredit;
}

struct CreditLoss {
    uint96 totalAccruedLoss;
    uint96 totalLossRecovery;
    uint64 lastLossUpdateDate;
    uint64 lossExpiringDate;
    uint96 lossRate;
}

enum CreditState {
    Deleted,
    Requested,
    Paused,
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
    // The date at which the receivable is created
    uint64 creationDate;
    // The amount of the receivable that has been paid so far
    uint96 paidAmount;
    // The ISO 4217 currency code that the receivable is denominated in
    uint16 currencyCode;
    // The date at which the receivable is expected to be fully paid
    uint64 maturityDate;
    ReceivableState state;
}

struct FacilityConfig {
    // Percentage of receivable nominal amount to be available for drawdown.
    uint16 advanceRateInBps;
    uint96 committedCreditLine;
    bool autoApproval;
}

//* Reserved for Richard review, to be deleted
// Update last 3 fileds name from totalXXX to accruedXXX because they are set to 0 when refreshPnL is called
struct PnLTracker {
    uint96 profitRate;
    uint96 lossRate;
    uint64 pnlLastUpdated;
    uint96 accruedProfit;
    uint96 accruedLoss;
    uint96 accruedLossRecovery;
}

struct Payment {
    uint96 principalPaid;
    uint96 yieldPaid;
    uint96 feesPaid;
    uint96 amountToCollect;
    bool oldLateFlag;
    bool newLateFlag;
}

struct ReceivableInput {
    uint96 receivableAmount;
    uint64 receivableId;
}
