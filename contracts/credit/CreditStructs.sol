// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PayPeriodDuration} from "../common/SharedDefs.sol";

/**
 * @notice CreditConfig keeps track of the static settings of a credit.
 * A CreditConfig is created after the approval of each credit.
 * @param creditLimit The maximum amount that can be borrowed.
 * @param committedAmount The amount that the borrower has committed to use. If the used credit
 * is less than this amount, the borrower will be charged yield using this amount.
 * @param periodDuration The duration of each pay period, e.g. monthly, quarterly or semi-annually.
 * @param numOfPeriods The number of periods before the credit expires.
 * @param yieldInBps The expected yield expressed in basis points, 1% is 100, 100% is 10000. It means different things
 * for different credit types:
 * 1. For credit line, it is APR.
 * 2. For factoring, it is factoring fee for the given period.
 * 3. For dynamic yield credit, it is the estimated APY.
 * @param advanceRateInBps Percentage of receivable nominal amount to be available for drawdown.
 * @param revolving A flag indicating if the repeated borrowing is allowed.
 * @param receivableAutoApproval Whether receivables will be automatically approved on drawdown. If `false`,
 * then the receivable needs to be manually approved before drawdown.
 */
struct CreditConfig {
    uint96 creditLimit;
    uint96 committedAmount;
    PayPeriodDuration periodDuration;
    uint16 numOfPeriods;
    uint16 yieldInBps;
    uint16 advanceRateInBps;
    bool revolving;
    bool receivableAutoApproval;
}

/**
 * @notice CreditRecord keeps track of the dynamic stats of a credit that change
 * from pay period to pay period, e.g. due info for each bill.
 * @param unbilledPrincipal The amount of principal not included in the bill.
 * @param nextDueDate The due date of the next payment.
 * @param nextDue The due amount of the next payment. This does not include past due.
 * @param yieldDue The yield due for the next payment.
 * @param totalPastDue The sum of late fee + past due. See DueDetail for more info.
 * @param missedPeriods The number of consecutive missed payments, for default processing.
 * @param remainingPeriods The number of payment periods until the maturity of the credit.
 * @param state The state of the credit, e.g. GoodStanding, Delayed, Defaulted.
 */
struct CreditRecord {
    uint96 unbilledPrincipal;
    uint64 nextDueDate;
    uint96 nextDue;
    uint96 yieldDue;
    uint96 totalPastDue;
    uint16 missedPeriods;
    uint16 remainingPeriods;
    CreditState state;
}

/**
 * @notice DueDetail records the detailed information about next due and past due
 * @notice CreditRecord.yieldDue = max(committed, accrued) - paid
 * @notice CreditRecord.totalPastDue = lateFee + principalPastDue + yieldPastDue
 * @notice This struct is necessary since commitment requirement might change within a period
 * @param lateFeeUpdatedDate The most recent date when late fee was updated.
 * @param lateFee The late charges only. It is always updated together with lateFeeUpdatedDate.
 * @param principalPastDue The unpaid principal past due.
 * @param yieldPastDue The unpaid yield past due.
 * @param committed The amount of yield computed from commitment set in CreditConfig
 * @param accrued The amount of yield based on actual usage
 * @param paid The amount of yield paid for the current period
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

enum CreditState {
    Deleted,
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

/**
 * @notice Information of a receivable.
 * @param receivableAmount The total expected payment amount of the receivable.
 * @param creationDate The date on which the receivable was created.
 * @param paidAmount The amount of the receivable that has been paid so far.
 * @param currencyCode The ISO 4217 currency code that the receivable is denominated in.
 * @param maturityDate The date on which the receivable is expected to be fully paid.
 * @param creator The original creator of the receivable.
 * @param state The state of the receivable.
 */
struct ReceivableInfo {
    uint96 receivableAmount;
    uint64 creationDate;
    uint96 paidAmount;
    uint16 currencyCode;
    uint64 maturityDate;
    address creator;
    ReceivableState state;
}

struct ReceivableInput {
    uint96 receivableAmount;
    uint64 receivableId;
}

enum CreditClosureReason {
    Paidoff,
    CreditLimitChangedToBeZero,
    OverwrittenByNewLine,
    AdminClosure
}
