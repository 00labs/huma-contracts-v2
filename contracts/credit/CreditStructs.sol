// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

// CreditConfig keeps track of the static settings of a credit.
// A CreditConfig is created after the approval of each credit.
struct CreditConfig {
    uint96 creditLimit;
    uint96 committedAmount;
    uint16 periodDuration;
    uint16 numOfPeriods; // number of periods
    // Yield in BPs, mean different things for different credit types.
    // For credit line, it is APR;
    // for factoring, it is factoring fee for the given period;
    // for dynamic yield credit, it is the estimated APY
    uint16 yieldInBps;
    bool revolving; // if repeated borrowing is allowed
    bool receivableBacked; // if the credit is receivable-backed
    bool borrowerLevelCredit; // whether the credit line is at the borrower-level vs receivable-level
    bool exclusive; // if the credit pool is exclusive to a borrower
}

// CreditRecord keep track of the dynamic stats of a credit that change
// from pay period to pay period, e.g. due info for each bill.
struct CreditRecord {
    uint96 unbilledPrincipal; // the amount of principal not included in the bill
    uint64 nextDueDate; // the due date of the next payment
    uint96 nextDue; // the due amount of the next payment. This does not include totalPastDue
    uint96 yieldDue; // yield due for the next payment
    uint96 totalPastDue; // the sum of lateFee + pastDue. See DueDetail for more info
    uint16 missedPeriods; // the number of consecutive missed payments, for default processing
    uint16 remainingPeriods; // the number of payment periods until the maturity of the credit line
    CreditState state;
}

/**
 * @notice DueDetail records the detail information about nextDue and pastDue
 * @notice committed is the amount of yield computed from commitment set in CreditConfig
 * @notice accrued is the amount of yield based on actual usage
 * @notice paid is the amount of yield paid for the current period
 * @notice CreditRecord.nextDue = max(committed, accrued) - paid
 * @notice lateFee tracks late charges only. It is always updated together with lastLateFeeDate.
 * @notice pastDue tracks unpaid yield only.
 * @notice when there is partial payment to past due, it is applied towards pastDue first,
 * then lateFee.
 * @notice CreditRecord.totalPastDue = lateFee + pastDue
 * @note This struct is necessary since commitment requirement might change within a period
 */
struct DueDetail {
    uint64 lastLateFeeDate;
    uint96 lateFee;
    uint96 pastDue;
    uint96 committed;
    uint96 accrued;
    uint96 paid;
}

struct CreditLoss {
    uint96 principalLoss;
    uint96 yieldLoss;
    uint96 feesLoss;
    uint96 principalRecovered;
    uint96 yieldRecovered;
    uint96 feesRecovered;
}

struct CreditLimit {
    uint96 creditLimit;
    uint96 availableCredit;
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
