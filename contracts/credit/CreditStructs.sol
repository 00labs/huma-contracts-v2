// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

// CreditConfig keeps track of the static settings of a credit.
// A CreditConfig is created after the approval of each credit.
struct CreditConfig {
    uint96 creditLimit;
    uint96 committedAmount;
    PayPeriodDuration periodDuration;
    uint16 numOfPeriods; // number of periods
    // Yield in BPs, mean different things for different credit types.
    // For credit line, it is APR;
    // for factoring, it is factoring fee for the given period;
    // for dynamic yield credit, it is the estimated APY
    uint16 yieldInBps;
    // Percentage of receivable nominal amount to be available for drawdown.
    uint16 advanceRateInBps;
    bool revolving; // if repeated borrowing is allowed
    bool autoApproval;
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
 * @notice DueDetail records the detailed information about nextDue and pastDue
 * @notice CreditRecord.nextDue = max(committed, accrued) - paid
 * @notice lateFee tracks late charges only. It is always updated together with lateFeeUpdatedDate.
 * @notice principalPastDue tracks unpaid principal past due.
 * @notice yieldPastDue tracks unpaid yield past due.
 * @notice committed is the amount of yield computed from commitment set in CreditConfig
 * @notice accrued is the amount of yield based on actual usage
 * @notice paid is the amount of yield paid for the current period
 * @notice when there is partial payment to past due, it is applied towards pastDue first,
 * then lateFee.
 * @notice CreditRecord.totalPastDue = lateFee + principalPastDue + yieldPastDue
 * @note This struct is necessary since commitment requirement might change within a period
 */
struct DueDetail {
    uint64 lateFeeUpdatedDate;
    uint96 lateFee;
    uint96 principalPastDue;
    uint96 yieldPastDue;
    // The following three fields are intended to track yield for the current period only.
    // They reset for every new period.
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

// todo The design of this struct is not optiized. There is duplication of creditLimit field
// in this struct and CreditConfig. Need to revisit and refine it.
struct CreditLimit {
    uint96 creditLimit;
    uint96 availableCredit;
}

enum PayPeriodDuration {
    Monthly,
    Quarterly,
    SemiAnnually
}

enum CreditState {
    Deleted,
    Requested,
    Approved,
    GoodStanding,
    Delayed,
    Defaulted,
    Paused
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

// todo Not sure if it is a good idea to separate this struct, will research and decide later.
struct ReceivableInput {
    uint96 receivableAmount;
    uint64 receivableId;
}

enum CreditLineClosureReason {
    Paidoff,
    CreditLimitChangedToBeZero,
    OverwrittenByNewLine,
    AdminClosure
}
