// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "../Errors.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {PoolConfig, PoolSettings} from "../PoolConfig.sol";
import {IPool} from "../interfaces/IPool.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";
import {CreditStorage} from "./CreditStorage.sol";
import {CreditConfig, CreditRecord, CreditLimit, CreditLoss, CreditState, DueDetail, CreditLoss, PayPeriodDuration} from "./CreditStructs.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {IFirstLossCover} from "../interfaces/IFirstLossCover.sol";
import {IPoolSafe} from "../interfaces/IPoolSafe.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {ICreditDueManager} from "./utils/interfaces/ICreditDueManager.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BORROWER_FIRST_LOSS_COVER_INDEX, DAYS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS, SECONDS_IN_A_DAY} from "../SharedDefs.sol";

import "hardhat/console.sol";

/**
 * Credit is the core borrowing concept in Huma Protocol. This abstract contract provides
 * basic operations that applies to all credits in Huma Protocol.
 */
abstract contract Credit is PoolConfigCache, CreditStorage, ICredit {
    /// Account billing info refreshed with the updated due amount and date
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
     * @notice A borrowing event has happened to the credit line
     * @param borrower the address of the borrower
     * @param borrowAmount the amount the user has borrowed
     * @param netAmountToBorrower the borrowing amount minus the fees that are charged upfront
     */
    event DrawdownMade(
        address indexed borrower,
        uint256 borrowAmount,
        uint256 netAmountToBorrower
    );

    /**
     * @notice A payment has been made against the credit line
     * @param borrower the address of the borrower
     * @param amount the payback amount
     * @param yieldDuePaid the amount of this payment applied to yield due in the current billing cycle
     * @param principalDuePaid the amount of this payment applied to principal due in the current billing cycle
     * @param unbilledPrincipalPaid the amount of this payment applied to unbilled principal
     * @param yieldPastDuePaid the amount of this payment applied to yield past due
     * @param lateFeePaid the amount of this payment applied to late fee
     * @param principalPastDuePaid the amount of this payment applied to principal past due
     * @param by the address that has triggered the process of marking the payment made.
     * In most cases, it is the borrower. In receivable factoring, it is PDSServiceAccount.
     */
    event PaymentMade(
        address indexed borrower,
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
     * @notice A payment has been made against the credit line
     * @param borrower the address of the borrower
     * @param amount the payback amount
     * @param nextDueDate the due date of the next payment
     * @param principalDue the principal due on the credit line after processing the payment
     * @param unbilledPrincipal the unbilled principal on the credit line after processing the payment
     * @param principalDuePaid the amount of this payment applied to principal due
     * @param unbilledPrincipalPaid the amount of this payment applied to unbilled principal
     * @param by the address that has triggered the process of marking the payment made.
     * In most cases, it is the borrower. In receivable factoring, it is PDSServiceAccount.
     */
    event PrincipalPaymentMade(
        address indexed borrower,
        uint256 amount,
        uint256 nextDueDate,
        uint256 principalDue,
        uint256 unbilledPrincipal,
        uint256 principalDuePaid,
        uint256 unbilledPrincipalPaid,
        address by
    );

    /**
     * @notice An existing credit has been closed
     * @param creditHash the credit hash
     * @param by the address who has triggered the default
     */
    event CreditClosedAfterPayOff(bytes32 indexed creditHash, address by);

    struct PaymentRecord {
        uint256 principalDuePaid;
        uint256 yieldDuePaid;
        uint256 unbilledPrincipalPaid;
        uint256 principalPastDuePaid;
        uint256 yieldPastDuePaid;
        uint256 lateFeePaid;
    }

    /// Shared setter to the credit record mapping for contract size consideration
    function setCreditRecord(bytes32 creditHash, CreditRecord memory cr) external {
        _onlyCreditManager();
        _setCreditRecord(creditHash, cr);
    }

    /// Shared setter to the DueDetail mapping for contract size consideration
    function setDueDetail(bytes32 creditHash, DueDetail memory dd) external {
        _onlyCreditManager();
        _setDueDetail(creditHash, dd);
    }

    /// Shared setter to the CreditLoss mapping for contract size consideration
    function setCreditLoss(bytes32 creditHash, CreditLoss memory cl) external {
        _onlyCreditManager();
        _setCreditLoss(creditHash, cl);
    }

    /**
     * @notice checks if the credit line is behind in payments
     * @dev When the account is in Approved state, there is no borrowing yet, being late
     * does not apply.
     * @dev After the bill is refreshed, the due date is updated, it is possible that the new due
     * date is in the future, but if the bill refresh has set missedPeriods, the account is late.
     */
    function isLate(bytes32 creditHash) public view virtual returns (bool lateFlag) {
        CreditRecord memory cr = getCreditRecord(creditHash);
        // TODO(jiatu): we shouldn't rely on the ordering of enums since there is no semantic guarantee
        // of the ordering.
        return (cr.state > CreditState.Approved &&
            (cr.missedPeriods > 0 ||
                block.timestamp >
                (cr.nextDueDate +
                    poolConfig.getPoolSettings().latePaymentGracePeriodInDays *
                    SECONDS_IN_A_DAY)));
    }

    /// Shared accessor to the credit record mapping for contract size consideration
    function getCreditRecord(bytes32 creditHash) public view returns (CreditRecord memory) {
        return _creditRecordMap[creditHash];
    }

    /// Shared accessor to DueDetail for contract size consideration
    function getDueDetail(bytes32 creditHash) public view returns (DueDetail memory) {
        return _dueDetailMap[creditHash];
    }

    /// Shared accessor to CreditLoss for contract size consideration
    function getCreditLoss(bytes32 creditHash) public view returns (CreditLoss memory) {
        return _creditLossMap[creditHash];
    }

    function updateDueInfo(
        bytes32 creditHash,
        CreditRecord memory cr,
        DueDetail memory dd
    ) external virtual {
        _onlyCreditManager();
        return _updateDueInfo(creditHash, cr, dd);
    }

    /// Shared setter to the credit record mapping for contract size consideration
    function _setCreditRecord(bytes32 creditHash, CreditRecord memory cr) internal {
        _creditRecordMap[creditHash] = cr;
    }

    /// Shared setter to the DueDetail mapping for contract size consideration
    function _setDueDetail(bytes32 creditHash, DueDetail memory dd) internal {
        _dueDetailMap[creditHash] = dd;
    }

    /// Shared setter to the CreditLoss mapping for contract size consideration
    function _setCreditLoss(bytes32 creditHash, CreditLoss memory cl) internal {
        _creditLossMap[creditHash] = cl;
    }

    /**
     * @notice Stores CreditRecord and DueDetail passed in for `creditHash`.
     * @param creditHash the hash of the credit
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
     * @notice drawdown helper function.
     * @param creditHash the credit hash
     * @param borrowAmount the amount to borrow
     * @dev Access control is done outside of this function.
     */
    function _drawdown(
        address borrower,
        bytes32 creditHash,
        uint256 borrowAmount
    ) internal virtual {
        // todo need to add return values
        CreditRecord memory cr = getCreditRecord(creditHash);
        CreditConfig memory cc = _getCreditConfig(creditHash);
        DueDetail memory dd = getDueDetail(creditHash);
        _checkDrawdownEligibility(borrower, cr, borrowAmount, cc.creditLimit);

        if (cr.state == CreditState.Approved) {
            // Flow for first drawdown.
            // Sets the principal, generates the first bill and sets credit status.
            cr.unbilledPrincipal = uint96(borrowAmount);
            (cr, dd) = feeManager.getDueInfo(cr, cc, dd, block.timestamp);
            cr.state = CreditState.GoodStanding;
        } else {
            // Disallow repeated drawdown for non-revolving credit
            if (!cc.revolving) revert Errors.attemptedDrawdownForNonrevolvingLine();

            if (block.timestamp > cr.nextDueDate) {
                // Bring the credit current and check if it is still in good standing.
                (cr, dd) = feeManager.getDueInfo(cr, cc, dd, block.timestamp);
                if (cr.state != CreditState.GoodStanding)
                    revert Errors.creditLineNotInGoodStandingState();
            }

            if (
                borrowAmount > (cc.creditLimit - cr.unbilledPrincipal - (cr.nextDue - cr.yieldDue))
            ) revert Errors.creditLineExceeded();

            // Add the yield of new borrowAmount for the remainder of the period
            (uint256 daysPassed, uint256 totalDays) = calendar.getDaysPassedInPeriod(
                cc.periodDuration,
                cr.nextDueDate
            );
            // It's important to note that the yield calculation includes the day of the drawdown. For instance,
            // if the borrower draws down at 11:59 PM on October 30th, the yield for October 30th must be paid.
            uint256 additionalYieldAccrued = feeManager.computeYieldDue(
                borrowAmount,
                cc.yieldInBps,
                totalDays - daysPassed
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

            uint256 principalRate = poolConfig.getMinPrincipalRateInBps();
            if (principalRate > 0) {
                // Record the additional principal due generated from the drawdown.
                uint256 additionalPrincipalDue = feeManager.computePrincipalDueForPartialPeriod(
                    borrowAmount,
                    principalRate,
                    totalDays - daysPassed,
                    cc.periodDuration
                );
                cr.unbilledPrincipal -= uint96(additionalPrincipalDue);
                cr.nextDue += uint96(additionalPrincipalDue);
            }
        }
        _updateDueInfo(creditHash, cr, dd);

        (uint256 netAmountToBorrower, uint256 platformProfit) = feeManager.distBorrowingAmount(
            borrowAmount
        );
        IPool(poolConfig.pool()).distributeProfit(platformProfit);

        // Transfer funds to the borrower
        poolSafe.withdraw(borrower, netAmountToBorrower);
        emit DrawdownMade(borrower, borrowAmount, netAmountToBorrower);
    }

    /**
     * @notice Makes one payment. If the payment amount is equal to or higher
     * than the payoff amount, it automatically triggers the payoff process. The protocol
     * never accepts payment amount that is higher than the payoff amount.
     * @param creditHash the hashcode of the credit
     * @param amount the payment amount
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     * @return isReviewRequired a flag indicating whether this payment transaction has been
     * flagged for review.
     */
    function _makePayment(
        address borrower,
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff, bool isReviewRequired) {
        if (amount == 0) revert Errors.zeroAmountProvided();

        CreditRecord memory cr = getCreditRecord(creditHash);
        if (cr.state == CreditState.Approved || cr.state == CreditState.Deleted) {
            revert Errors.creditLineNotInStateForMakingPayment();
        }
        CreditConfig memory cc = _getCreditConfig(creditHash);
        DueDetail memory dd = getDueDetail(creditHash);
        (cr, dd) = feeManager.getDueInfo(cr, cc, dd, block.timestamp);
        CreditState oldCRState = cr.state;

        uint256 payoffAmount = feeManager.getPayoffAmount(cr);
        uint256 amountToCollect = amount < payoffAmount ? amount : payoffAmount;
        PaymentRecord memory paymentRecord;

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
                    cr.totalPastDue = 0;
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
                    cr.missedPeriods = 0;
                    dd.lateFeeUpdatedDate = 0;
                    // Moves account to GoodStanding if it was delayed.
                    if (cr.state == CreditState.Delayed) cr.state = CreditState.GoodStanding;

                    // If all next due is paid off and the bill has already entered the new billing cycle,
                    // then refresh the bill.
                    if (block.timestamp > cr.nextDueDate) {
                        (cr, dd) = feeManager.getDueInfo(cr, cc, dd, block.timestamp);
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

            if (cr.state == CreditState.Defaulted) {
                // Clear `CreditLoss` if recovered from default.
                CreditLoss memory cl = getCreditLoss(creditHash);
                cl.principalLoss = 0;
                cl.yieldLoss = 0;
                cl.feesLoss = 0;
                _setCreditLoss(creditHash, cl);
            }
            // Closes the credit line if it is in the final period
            if (cr.remainingPeriods == 0) {
                cr.state = CreditState.Deleted;
                emit CreditClosedAfterPayOff(creditHash, msg.sender);
            } else cr.state = CreditState.GoodStanding;
        }

        _updateDueInfo(creditHash, cr, dd);

        if (amountToCollect > 0) {
            poolSafe.deposit(msg.sender, amountToCollect);
            if (oldCRState == CreditState.Defaulted) {
                IPool(poolConfig.pool()).distributeLossRecovery(amountToCollect);
            } else {
                uint256 profit = paymentRecord.yieldPastDuePaid +
                    paymentRecord.yieldDuePaid +
                    paymentRecord.lateFeePaid;
                if (profit > 0) {
                    IPool(poolConfig.pool()).distributeProfit(profit);
                }
            }
            emit PaymentMade(
                borrower,
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
     * @notice Borrower makes principal payment. The payment is applied towards principal only.
     * @param creditHash the hashcode of the credit
     * @param amount the payment amount
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     */
    function _makePrincipalPayment(
        address borrower,
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff) {
        if (amount == 0) revert Errors.zeroAmountProvided();

        CreditRecord memory cr = getCreditRecord(creditHash);
        DueDetail memory dd = getDueDetail(creditHash);
        if (cr.state != CreditState.GoodStanding) {
            revert Errors.creditLineNotInStateForMakingPrincipalPayment();
        }
        if (block.timestamp > cr.nextDueDate) {
            CreditConfig memory cc = _getCreditConfig(creditHash);
            (cr, dd) = feeManager.getDueInfo(cr, cc, dd, block.timestamp);
            if (cr.state != CreditState.GoodStanding) {
                revert Errors.creditLineNotInStateForMakingPrincipalPayment();
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
        uint256 unbilledPrincipalPaid;
        if (amount < principalDue) {
            cr.nextDue = uint96(cr.nextDue - amount);
            principalDuePaid = amount;
        } else {
            principalDuePaid = principalDue;
            unbilledPrincipalPaid = amountToCollect - principalDuePaid;
            cr.nextDue = uint96(cr.nextDue - principalDuePaid);
            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal - unbilledPrincipalPaid);
        }

        // Adjust credit record status if needed. This happens when the next due happens to be 0.
        if (cr.nextDue == 0) {
            if (cr.unbilledPrincipal == 0 && cr.remainingPeriods == 0) {
                cr.state = CreditState.Deleted;
                emit CreditClosedAfterPayOff(creditHash, msg.sender);
            } else cr.state = CreditState.GoodStanding;
        }

        _updateDueInfo(creditHash, cr, dd);

        if (amountToCollect > 0) {
            poolSafe.deposit(msg.sender, amountToCollect);
            emit PrincipalPaymentMade(
                borrower,
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

    /**
     * @notice Checks if drawdown is allowed for the borrower at this point of time
     * @dev Checks to make sure the following conditions are met:
     * 1) The borrower has satisfied the first loss obligation
     * 2) The credit is in Approved or Goodstanding state
     * 3) For first time drawdown, the approval is not expired
     * 4) Drawdown amount is no more than available credit
     * @dev Please note cr.nextDueDate is the credit expiration date for the first drawdown.
     */
    function _checkDrawdownEligibility(
        address borrower,
        CreditRecord memory cr,
        uint256 borrowAmount,
        uint256 creditLimit
    ) internal view {
        if (!firstLossCover.isSufficient(borrower))
            revert Errors.insufficientBorrowerFirstLossCover();

        if (cr.state == CreditState.Approved) {
            // After the credit approval, if the credit has commitment and a designated start date, then the
            // credit will kick start on that whether the borrower has initiated the drawdown or not.
            // The date is set in `cr.nextDueDate` in `approveCredit()`.
            if (cr.nextDueDate > 0 && block.timestamp < cr.nextDueDate)
                revert Errors.firstDrawdownTooSoon();

            if (borrowAmount > creditLimit) revert Errors.creditLineExceeded();
        } else if (cr.state != CreditState.GoodStanding) {
            revert Errors.creditNotInStateForDrawdown();
        } else if (cr.nextDue != 0 && block.timestamp > cr.nextDueDate) {
            // Prevent drawdown if the credit is in good standing, but has due outstanding and is currently in the
            // late payment grace period or later. In this case, we want the borrower to pay off the due before being
            // able to make further drawdown.
            revert Errors.drawdownNotAllowedInLatePaymentGracePeriod();
        }
    }

    function _getCreditConfig(bytes32 creditHash) internal view returns (CreditConfig memory) {
        return creditManager.getCreditConfig(creditHash);
    }

    /// "Modifier" function that limits access to pdsServiceAccount only.
    function _onlyPDSServiceAccount() internal view {
        if (msg.sender != humaConfig.pdsServiceAccount())
            revert Errors.paymentDetectionServiceAccountRequired();
    }

    function _onlyCreditManager() internal view {
        if (msg.sender != address(creditManager)) revert Errors.todo();
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = address(_poolConfig.humaConfig());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(addr);

        addr = _poolConfig.creditDueManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        feeManager = ICreditDueManager(addr);

        addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);

        addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.getFirstLossCover(BORROWER_FIRST_LOSS_COVER_INDEX);
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        firstLossCover = IFirstLossCover(addr);

        addr = _poolConfig.creditManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        creditManager = ICreditManager(addr);
    }
}
