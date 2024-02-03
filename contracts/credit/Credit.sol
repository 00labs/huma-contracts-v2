// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "../common/Errors.sol";
import {HumaConfig} from "../common/HumaConfig.sol";
import {PoolConfig} from "../common/PoolConfig.sol";
import {IPool} from "../liquidity/interfaces/IPool.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {CreditStorage} from "./CreditStorage.sol";
import {CreditConfig, CreditRecord, CreditState, DueDetail} from "./CreditStructs.sol";
import {PayPeriodDuration} from "../common/SharedDefs.sol";
import {IFirstLossCover} from "../liquidity/interfaces/IFirstLossCover.sol";
import {IPoolSafe} from "../liquidity/interfaces/IPoolSafe.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";
import {BORROWER_LOSS_COVER_INDEX} from "../common/SharedDefs.sol";

/**
 * @notice Credit is the core borrowing concept in Huma Protocol. This abstract contract operates at the
 * creditHash level and provides basic operations that applies to all types of credits.
 */
abstract contract Credit is PoolConfigCache, CreditStorage, ICredit {
    /**
     * @notice Keeps track of the payment amount applied towards each part of the bill due.
     * @dev This struct is used to get around the "Stack too deep" error in _makePayment().
     */
    struct PaymentRecord {
        uint256 principalDuePaid;
        uint256 yieldDuePaid;
        uint256 unbilledPrincipalPaid;
        uint256 principalPastDuePaid;
        uint256 yieldPastDuePaid;
        uint256 lateFeePaid;
    }

    /**
     * @notice Account billing info refreshed with the updated due amount and date.
     * @param creditHash The hash of the credit.
     * @param newDueDate The updated due date of the bill.
     * @param amountDue The amount due on the bill.
     */
    event BillRefreshed(bytes32 indexed creditHash, uint256 newDueDate, uint256 amountDue);

    /**
     * @notice Credit line created
     * @param borrower the address of the borrower
     * @param creditLimit the credit limit of the credit line
     * @param aprInBps interest rate (APR) expressed in basis points, 1% is 100, 100% is 10000
     * @param periodDuration The pay period duration
     * @param remainingPeriods how many cycles are there before the credit line expires
     * @param approved flag that shows if the credit line has been approved or not
     */
    event CreditInitiated(
        address indexed borrower,
        uint256 creditLimit,
        uint256 aprInBps,
        PayPeriodDuration periodDuration,
        uint256 remainingPeriods,
        bool approved
    );

    /// Credit limit for an existing credit line has been changed
    event CreditLineChanged(
        address indexed borrower,
        uint256 oldCreditLimit,
        uint256 newCreditLimit
    );

    /**
     * @notice A borrowing event has happened to the credit.
     * @param borrower The address of the borrower.
     * @param borrowAmount The amount the user has borrowed.
     * @param netAmountToBorrower The borrowing amount minus the fees that are charged upfront.
     */
    event DrawdownMade(
        address indexed borrower,
        uint256 borrowAmount,
        uint256 netAmountToBorrower
    );

    /**
     * @notice A payment has been made against the credit.
     * @param borrower The address of the borrower.
     * @param payer The address from which the money is coming.
     * @param amount The payback amount.
     * @param yieldDuePaid The amount of this payment applied to yield due in the current billing cycle.
     * @param principalDuePaid The amount of this payment applied to principal due in the current billing cycle.
     * @param unbilledPrincipalPaid The amount of this payment applied to unbilled principal.
     * @param yieldPastDuePaid The amount of this payment applied to yield past due.
     * @param lateFeePaid The amount of this payment applied to late fee.
     * @param principalPastDuePaid The amount of this payment applied to principal past due.
     * @param by The address that has triggered the process of marking the payment made.
     */
    event PaymentMade(
        address indexed borrower,
        address indexed payer,
        uint256 amount,
        uint256 yieldDuePaid,
        uint256 principalDuePaid,
        uint256 unbilledPrincipalPaid,
        uint256 yieldPastDuePaid,
        uint256 lateFeePaid,
        uint256 principalPastDuePaid,
        address by
    );

    /**
     * @notice A principal payment has been made against the credit.
     * @param borrower The address of the borrower.
     * @param payer The address from which the money is coming.
     * @param amount The payback amount.
     * @param nextDueDate The due date of the next payment.
     * @param principalDue The principal due on the credit after processing the payment.
     * @param unbilledPrincipal The unbilled principal on the credit after processing the payment.
     * @param principalDuePaid The amount of this payment applied to principal due.
     * @param unbilledPrincipalPaid The amount of this payment applied to unbilled principal.
     * @param by The address that has triggered the process of marking the payment made.
     */
    event PrincipalPaymentMade(
        address indexed borrower,
        address indexed payer,
        uint256 amount,
        uint256 nextDueDate,
        uint256 principalDue,
        uint256 unbilledPrincipal,
        uint256 principalDuePaid,
        uint256 unbilledPrincipalPaid,
        address by
    );

    /**
     * @notice An existing credit has been closed.
     * @param creditHash The credit hash.
     * @param by The address who triggered the pay off that closed the credit.
     */
    event CreditClosedAfterPayOff(bytes32 indexed creditHash, address by);

    /// @inheritdoc ICredit
    function setCreditRecord(bytes32 creditHash, CreditRecord memory cr) external {
        _onlyCreditManager();
        _setCreditRecord(creditHash, cr);
    }

    /// @inheritdoc ICredit
    function updateDueInfo(
        bytes32 creditHash,
        CreditRecord memory cr,
        DueDetail memory dd
    ) external virtual {
        _onlyCreditManager();
        return _updateDueInfo(creditHash, cr, dd);
    }

    /// @inheritdoc ICredit
    function getCreditRecord(bytes32 creditHash) public view returns (CreditRecord memory) {
        return _creditRecordMap[creditHash];
    }

    /// @inheritdoc ICredit
    function getDueDetail(bytes32 creditHash) public view returns (DueDetail memory) {
        return _dueDetailMap[creditHash];
    }

    /// Shared setter to the credit record mapping for contract size consideration
    function _setCreditRecord(bytes32 creditHash, CreditRecord memory cr) internal {
        _creditRecordMap[creditHash] = cr;
    }

    /// Shared setter to the DueDetail mapping for contract size consideration
    function _setDueDetail(bytes32 creditHash, DueDetail memory dd) internal {
        _dueDetailMap[creditHash] = dd;
    }

    /**
     * @notice Stores CreditRecord and DueDetail passed in for creditHash.
     * @param creditHash The hash of the credit.
     * @param cr The CreditRecord to set.
     * @param dd The DueDetail to set.
     */
    function _updateDueInfo(
        bytes32 creditHash,
        CreditRecord memory cr,
        DueDetail memory dd
    ) internal virtual {
        _setCreditRecord(creditHash, cr);
        _setDueDetail(creditHash, dd);
        emit BillRefreshed(creditHash, cr.nextDueDate, cr.nextDue);
    }

    /**
     * @notice Helper function for drawdown.
     * @param borrower The address of the borrower.
     * @param creditHash The hash of the credit.
     * @param borrowAmount The amount to borrow.
     * @return netAmountToBorrower The borrowing amount minus the fees that are charged upfront.
     * @custom:access Access control is done outside of this function.
     */
    function _drawdown(
        address borrower,
        bytes32 creditHash,
        uint256 borrowAmount
    ) internal virtual returns (uint256 netAmountToBorrower) {
        if (borrowAmount == 0) revert Errors.ZeroAmountProvided();

        CreditRecord memory cr = getCreditRecord(creditHash);
        CreditConfig memory cc = _getCreditConfig(creditHash);
        DueDetail memory dd = getDueDetail(creditHash);
        _checkDrawdownEligibility(cr, borrowAmount, cc.creditLimit);

        if (cr.state == CreditState.Approved) {
            // Flow for first drawdown.
            // Sets the principal, generates the first bill and sets credit status.
            cr.unbilledPrincipal = uint96(borrowAmount);
            (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
            // Note that we don't need to check whether we are in the last period or beyond here because in the absence
            // of the designated credit start date, it's the initial drawdown that kicks off a credit, i.e.
            // the initial drawdown always happens in the first period.
            cr.state = CreditState.GoodStanding;
        } else {
            // Disallow repeated drawdown for non-revolving credit
            if (!cc.revolving) revert Errors.AttemptedDrawdownOnNonRevolvingLine();

            if (block.timestamp > cr.nextDueDate) {
                // Bring the credit current and check if it is still in good standing.
                (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
                if (cr.remainingPeriods == 0)
                    revert Errors.DrawdownNotAllowedInFinalPeriodAndBeyond();
                if (cr.state != CreditState.GoodStanding)
                    revert Errors.CreditNotInStateForDrawdown();
            }

            if (
                borrowAmount > (cc.creditLimit - cr.unbilledPrincipal - (cr.nextDue - cr.yieldDue))
            ) revert Errors.CreditLimitExceeded();

            // Add the yield of new borrowAmount for the remainder of the period
            (uint256 additionalYieldAccrued, uint256 additionalPrincipalDue) = dueManager
                .computeAdditionalYieldAccruedAndPrincipalDueForDrawdown(
                    cc.periodDuration,
                    borrowAmount,
                    cr.nextDueDate,
                    cc.yieldInBps
                );
            dd.accrued += uint96(additionalYieldAccrued);
            if (dd.accrued > dd.committed) {
                // 1. If `dd.committed` was higher than `dd.accrued` before the drawdown but lower afterwards,
                // then we need to reset yield due using the accrued amount.
                // 2. If `dd.committed` was lower than `dd.accrued` before the drawdown, now it's only going to be even
                // lower, so we need to recompute the yield due to account for the additional yield generated
                // from the additional principal.
                // 3. Otherwise, yield due stays as-is.
                cr.nextDue = cr.nextDue - cr.yieldDue + dd.accrued - dd.paid;
                cr.yieldDue = dd.accrued - dd.paid;
            }
            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal + borrowAmount);

            if (additionalPrincipalDue > 0) {
                // Record the additional principal due generated from the drawdown.
                cr.unbilledPrincipal -= uint96(additionalPrincipalDue);
                cr.nextDue += uint96(additionalPrincipalDue);
            }
        }
        _updateDueInfo(creditHash, cr, dd);

        uint256 platformProfit = 0;
        (netAmountToBorrower, platformProfit) = dueManager.distBorrowingAmount(borrowAmount);
        pool.distributeProfit(platformProfit);

        // Transfer funds to the borrower
        poolSafe.withdraw(borrower, netAmountToBorrower);
        emit DrawdownMade(borrower, borrowAmount, netAmountToBorrower);
    }

    /**
     * @notice Makes one payment. If the payment amount is equal to or higher
     * than the payoff amount, it automatically triggers the payoff process. The protocol
     * never accepts payment amount that is higher than the payoff amount.
     * @param creditHash The hashcode of the credit.
     * @param amount The payment amount.
     * @return amountPaid The actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff A flag indicating whether the account has been paid off.
     * @return isReviewRequired a flag indicating whether this payment transaction has been
     * flagged for review.
     */
    function _makePayment(
        address borrower,
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff, bool isReviewRequired) {
        if (amount == 0) revert Errors.ZeroAmountProvided();

        CreditRecord memory cr = getCreditRecord(creditHash);
        if (cr.state == CreditState.Approved || cr.state == CreditState.Deleted) {
            revert Errors.CreditNotInStateForMakingPayment();
        }
        CreditConfig memory cc = _getCreditConfig(creditHash);
        DueDetail memory dd = getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
        CreditState oldCRState = cr.state;

        uint256 payoffAmount = dueManager.getPayoffAmount(cr);
        uint256 amountToCollect = amount < payoffAmount ? amount : payoffAmount;
        PaymentRecord memory paymentRecord = PaymentRecord(0, 0, 0, 0, 0, 0);

        if (amount < payoffAmount) {
            // Apply the payment to past due first.
            if (cr.totalPastDue > 0) {
                if (amount >= cr.totalPastDue) {
                    paymentRecord.yieldPastDuePaid = dd.yieldPastDue;
                    paymentRecord.principalPastDuePaid = dd.principalPastDue;
                    paymentRecord.lateFeePaid = dd.lateFee;
                    amount -= cr.totalPastDue;
                    dd.lateFee = 0;
                    dd.yieldPastDue = 0;
                    dd.principalPastDue = 0;
                    dd.lateFeeUpdatedDate = 0;
                    cr.totalPastDue = 0;
                    cr.missedPeriods = 0;
                    // Moves account to GoodStanding if it was Delayed.
                    if (cr.state == CreditState.Delayed) cr.state = CreditState.GoodStanding;
                } else {
                    // If the payment is not enough to cover the total amount past due, then
                    // apply the payment to the yield past due, followed by principal past due,
                    // then lastly late fees.
                    if (amount > dd.yieldPastDue) {
                        amount -= dd.yieldPastDue;
                        paymentRecord.yieldPastDuePaid = dd.yieldPastDue;
                        dd.yieldPastDue = 0;
                    } else {
                        paymentRecord.yieldPastDuePaid = amount;
                        dd.yieldPastDue -= uint96(amount);
                        amount = 0;
                    }
                    if (amount > dd.lateFee) {
                        amount -= dd.lateFee;
                        paymentRecord.lateFeePaid = dd.lateFee;
                        dd.lateFee = 0;
                    } else {
                        paymentRecord.lateFeePaid = amount;
                        dd.lateFee -= uint96(amount);
                        amount = 0;
                    }
                    // Since `amount < totalPastDue`, the remaining amount must be smaller than
                    // the principal past due (unless the principal past due is 0, in which case the amount must
                    // be 0 as well).
                    if (amount > 0) {
                        paymentRecord.principalPastDuePaid = amount;
                        dd.principalPastDue -= uint96(amount);
                        amount = 0;
                    }
                    cr.totalPastDue -= uint96(
                        paymentRecord.yieldPastDuePaid +
                            paymentRecord.principalPastDuePaid +
                            paymentRecord.lateFeePaid
                    );
                }
            }

            // Apply the remaining payment amount (if any) to next due.
            if (amount > 0) {
                if (amount < cr.nextDue) {
                    // Apply the payment to yield due first, then principal due.
                    paymentRecord.yieldDuePaid = amount < cr.yieldDue ? amount : cr.yieldDue;
                    dd.paid += uint96(paymentRecord.yieldDuePaid);
                    cr.yieldDue -= uint96(paymentRecord.yieldDuePaid);
                    paymentRecord.principalDuePaid = amount - paymentRecord.yieldDuePaid;
                    cr.nextDue = uint96(cr.nextDue - amount);
                    amount = 0;
                } else {
                    // Apply extra payments towards principal, reduce unbilledPrincipal amount.
                    paymentRecord.principalDuePaid = cr.nextDue - cr.yieldDue;
                    paymentRecord.yieldDuePaid = cr.yieldDue;
                    dd.paid += uint96(cr.yieldDue);
                    paymentRecord.unbilledPrincipalPaid =
                        amount -
                        paymentRecord.principalDuePaid -
                        paymentRecord.yieldDuePaid;
                    cr.unbilledPrincipal -= uint96(paymentRecord.unbilledPrincipalPaid);
                    cr.nextDue = 0;
                    cr.yieldDue = 0;

                    // If all next due is paid off and the bill has already entered the new billing cycle,
                    // then refresh the bill.
                    if (block.timestamp > cr.nextDueDate) {
                        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
                    }
                }
            }
        } else {
            // Payoff
            paymentRecord.principalDuePaid = cr.nextDue - cr.yieldDue;
            paymentRecord.yieldDuePaid = cr.yieldDue;
            paymentRecord.unbilledPrincipalPaid = cr.unbilledPrincipal;
            paymentRecord.principalPastDuePaid = dd.principalPastDue;
            paymentRecord.yieldPastDuePaid = dd.yieldPastDue;
            paymentRecord.lateFeePaid = dd.lateFee;

            // All past due is 0.
            dd.lateFee = 0;
            dd.lateFeeUpdatedDate = 0;
            dd.yieldPastDue = 0;
            dd.principalPastDue = 0;

            // All next due is also 0.
            dd.paid += uint96(cr.yieldDue);
            cr.unbilledPrincipal = 0;
            cr.yieldDue = 0;
            cr.nextDue = 0;
            cr.totalPastDue = 0;
            cr.missedPeriods = 0;

            // Close the credit if it is in the final period
            if (cr.remainingPeriods == 0) {
                cr.state = CreditState.Deleted;
                emit CreditClosedAfterPayOff(creditHash, msg.sender);
            } else cr.state = CreditState.GoodStanding;
        }

        _updateDueInfo(creditHash, cr, dd);

        if (amountToCollect > 0) {
            address payer = _getPaymentOriginator(borrower);
            poolSafe.deposit(payer, amountToCollect);
            if (oldCRState == CreditState.Defaulted) {
                pool.distributeLossRecovery(amountToCollect);
            } else {
                uint256 profit = paymentRecord.yieldPastDuePaid +
                    paymentRecord.yieldDuePaid +
                    paymentRecord.lateFeePaid;
                if (profit > 0) {
                    pool.distributeProfit(profit);
                }
            }
            emit PaymentMade(
                borrower,
                payer,
                amountToCollect,
                paymentRecord.yieldDuePaid,
                paymentRecord.principalDuePaid,
                paymentRecord.unbilledPrincipalPaid,
                paymentRecord.yieldPastDuePaid,
                paymentRecord.lateFeePaid,
                paymentRecord.principalPastDuePaid,
                msg.sender
            );
        }

        // amountToCollect == payoffAmount indicates paidoff or not. >= is a safe practice
        return (amountToCollect, amountToCollect >= payoffAmount, false);
    }

    /**
     * @notice Makes a payment that's applied towards principal only.
     * @param creditHash The hashcode of the credit.
     * @param amount The payment amount.
     * @return amountPaid The actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     */
    function _makePrincipalPayment(
        address borrower,
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff) {
        if (amount == 0) revert Errors.ZeroAmountProvided();

        CreditRecord memory cr = getCreditRecord(creditHash);
        DueDetail memory dd = getDueDetail(creditHash);
        if (cr.state != CreditState.GoodStanding) {
            revert Errors.CreditNotInStateForMakingPrincipalPayment();
        }
        if (block.timestamp > cr.nextDueDate) {
            CreditConfig memory cc = _getCreditConfig(creditHash);
            (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
            if (cr.state != CreditState.GoodStanding) {
                revert Errors.CreditNotInStateForMakingPrincipalPayment();
            }
        }

        uint256 principalDue = cr.nextDue - cr.yieldDue;
        // Principal past due must be 0 here since we do not allow principal payment
        // if the bill is late, hence `totalPrincipal` is just principal next due and
        // unbilled principal.
        uint256 totalPrincipal = principalDue + cr.unbilledPrincipal;
        uint256 amountToCollect = amount < totalPrincipal ? amount : totalPrincipal;

        // Pay principal due first, then unbilled principal.
        uint256 principalDuePaid;
        uint256 unbilledPrincipalPaid = 0;
        if (amount < principalDue) {
            cr.nextDue = uint96(cr.nextDue - amount);
            principalDuePaid = amount;
        } else {
            principalDuePaid = principalDue;
            unbilledPrincipalPaid = amountToCollect - principalDuePaid;
            cr.nextDue = uint96(cr.nextDue - principalDuePaid);
            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal - unbilledPrincipalPaid);
        }

        if (cr.nextDue == 0 && cr.unbilledPrincipal == 0 && cr.remainingPeriods == 0) {
            // Close the credit if all outstanding balance has been paid off.
            cr.state = CreditState.Deleted;
            emit CreditClosedAfterPayOff(creditHash, msg.sender);
        }

        _updateDueInfo(creditHash, cr, dd);

        if (amountToCollect > 0) {
            address payer = _getPaymentOriginator(borrower);
            poolSafe.deposit(payer, amountToCollect);
            emit PrincipalPaymentMade(
                borrower,
                payer,
                amountToCollect,
                cr.nextDueDate,
                cr.nextDue - cr.yieldDue,
                cr.unbilledPrincipal,
                principalDuePaid,
                unbilledPrincipalPaid,
                msg.sender
            );
        }

        // The credit is paid off if there is no next due or unbilled principal.
        return (amountToCollect, cr.nextDue == 0 && cr.unbilledPrincipal == 0);
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = address(_poolConfig.humaConfig());
        assert(addr != address(0));
        humaConfig = HumaConfig(addr);

        addr = _poolConfig.creditDueManager();
        assert(addr != address(0));
        dueManager = ICreditDueManager(addr);

        addr = _poolConfig.pool();
        assert(addr != address(0));
        pool = IPool(addr);

        addr = _poolConfig.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.getFirstLossCover(BORROWER_LOSS_COVER_INDEX);
        assert(addr != address(0));
        firstLossCover = IFirstLossCover(addr);

        addr = _poolConfig.creditManager();
        assert(addr != address(0));
        creditManager = ICreditManager(addr);
    }

    /**
     * @notice Checks if drawdown is allowed for the borrower at this point in time.
     * @param cr The CreditRecord to check against.
     * @param borrowAmount The amount the borrower wants to borrow.
     * @param creditLimit The maximum amount that can be borrowed from the credit.
     */
    function _checkDrawdownEligibility(
        CreditRecord memory cr,
        uint256 borrowAmount,
        uint256 creditLimit
    ) internal view {
        if (cr.remainingPeriods == 0) revert Errors.DrawdownNotAllowedInFinalPeriodAndBeyond();
        if (!firstLossCover.isSufficient()) revert Errors.InsufficientFirstLossCover();
        if (borrowAmount > poolSafe.getAvailableBalanceForPool())
            revert Errors.InsufficientPoolBalanceForDrawdown();
        if (cr.state == CreditState.Approved) {
            // After the credit approval, if the credit has commitment and a designated start date, then the
            // credit will kick start on that whether the borrower has initiated the drawdown or not.
            // The date is set in `cr.nextDueDate` in `approveCredit()`.
            if (cr.nextDueDate > 0 && block.timestamp < cr.nextDueDate)
                revert Errors.FirstDrawdownTooEarly();

            if (borrowAmount > creditLimit) revert Errors.CreditLimitExceeded();
        } else if (cr.state != CreditState.GoodStanding) {
            revert Errors.CreditNotInStateForDrawdown();
        } else if (cr.nextDue != 0 && block.timestamp > cr.nextDueDate) {
            // Prevent drawdown if the credit is in good standing, but has due outstanding and is currently in the
            // late payment grace period or later. In this case, we want the borrower to pay off the due before being
            // able to make further drawdown.
            revert Errors.DrawdownNotAllowedAfterDueDateWithUnpaidDue();
        }
    }

    function _getDueInfo(
        bytes32 creditHash
    ) internal view returns (CreditRecord memory cr, DueDetail memory dd) {
        CreditConfig memory cc = creditManager.getCreditConfig(creditHash);
        cr = getCreditRecord(creditHash);
        dd = getDueDetail(creditHash);
        return dueManager.getDueInfo(cr, cc, dd, block.timestamp);
    }

    function _getNextBillRefreshDate(
        bytes32 creditHash
    ) internal view returns (uint256 refreshDate) {
        CreditRecord memory cr = getCreditRecord(creditHash);
        return dueManager.getNextBillRefreshDate(cr);
    }

    function _getCreditConfig(bytes32 creditHash) internal view returns (CreditConfig memory) {
        return creditManager.getCreditConfig(creditHash);
    }

    /// "Modifier" function that limits access to the Sentinel Service account only.
    function _onlySentinelServiceAccount() internal view {
        if (msg.sender != humaConfig.sentinelServiceAccount())
            revert Errors.SentinelServiceAccountRequired();
    }

    /**
     * @notice Returns from whose account the funds for payment should be extracted.
     * @notice This function exists because of Auto-pay:
     * 1. For Auto-pay, the funds should be coming from the borrower's account.
     * 2. In all other case, the funds should be coming from whoever is initiating the payment.
     * @param borrower The credit borrower.
     * @return originator The account where the funds of payment should be coming from.
     */
    function _getPaymentOriginator(address borrower) internal view returns (address originator) {
        return msg.sender == humaConfig.sentinelServiceAccount() ? borrower : msg.sender;
    }

    function _onlyCreditManager() internal view {
        if (msg.sender != address(creditManager)) revert Errors.AuthorizedContractCallerRequired();
    }
}
