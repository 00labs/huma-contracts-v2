// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditFeeManager} from "./interfaces/ICreditFeeManager.sol";
import {CreditConfig, CreditRecord, CreditState} from "../CreditStructs.sol";
import {PoolConfig, PoolSettings} from "../../PoolConfig.sol";
import {ICalendar} from "../interfaces/ICalendar.sol";
import "../../SharedDefs.sol";
import {Errors} from "../../Errors.sol";
import {PoolConfigCache} from "../../PoolConfigCache.sol";

import "hardhat/console.sol";

contract BaseCreditFeeManager is PoolConfigCache, ICreditFeeManager {
    ICalendar public calendar;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);
    }

    /**
     * @notice Compute interest and principal
     */
    function accruedDebt(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        CreditRecord memory dealRecord
    ) external view virtual returns (uint256 accruedInterest, uint256 accruedPrincipal) {}

    /**
     * @notice Computes the late fee including both the flat fee and percentage fee
     * @param totalBalance the total balance including amount due and unbilled principal
     * @return fees the amount of late fees to be charged
     * @dev Charges only if 1) there is outstanding due, 2) the due date has passed
     */
    function calcLateFee(
        uint256 totalBalance
    ) public view virtual override returns (uint256 fees) {
        uint256 lateFeeBps;
        (fees, lateFeeBps, ) = poolConfig.getFees();

        if (lateFeeBps > 0) fees += (totalBalance * lateFeeBps) / HUNDRED_PERCENT_IN_BPS;
    }

    /**
     * @notice Computes the front loading fee including both the flat fee and percentage fee
     * @param _amount the borrowing amount
     * @return fees the amount of fees to be charged for this borrowing
     */
    function calcFrontLoadingFee(
        uint256 _amount
    ) public view virtual override returns (uint256 fees) {
        uint256 frontLoadingFeeBps;
        (fees, frontLoadingFeeBps) = poolConfig.getFrontLoadingFees();
        if (frontLoadingFeeBps > 0)
            fees += (_amount * frontLoadingFeeBps) / HUNDRED_PERCENT_IN_BPS;
    }

    function getPayoffAmount(
        CreditRecord memory cr,
        uint256 yieldInBps
    ) external view virtual override returns (uint256 payoffAmount) {
        uint256 principal = cr.unbilledPrincipal + cr.totalDue - cr.yieldDue - cr.feesDue;
        payoffAmount = uint256(cr.totalDue + cr.unbilledPrincipal);
        if (block.timestamp < cr.nextDueDate) {
            // Subtract the yield for the days between the current date and the due date when payment is made
            // in advance of the due date.
            uint256 remainingYield = (yieldInBps *
                principal *
                (cr.nextDueDate - block.timestamp)) / (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS);
            assert(payoffAmount >= remainingYield);
            payoffAmount -= remainingYield;
        }
    }

    /**
     * @notice Apply front loading fee, distribute the total amount to borrower, pool, & protocol
     * @param borrowAmount the amount of the borrowing
     * @return amtToBorrower the amount that the borrower can take
     * @return platformFees the platform charges
     * @dev the protocol always takes a percentage of the total fee generated
     */
    function distBorrowingAmount(
        uint256 borrowAmount
    ) external view virtual returns (uint256 amtToBorrower, uint256 platformFees) {
        // Calculate platform fee, which includes protocol fee and pool fee
        platformFees = calcFrontLoadingFee(borrowAmount);

        if (borrowAmount < platformFees) revert Errors.borrowingAmountLessThanPlatformFees();

        amtToBorrower = borrowAmount - platformFees;

        return (amtToBorrower, platformFees);
    }

    /**
     * @notice Sets the standard front loading and late fee policy for the fee manager
     * @param _frontLoadingFeeFlat flat fee portion of the front loading fee
     * @param _frontLoadingFeeBps a fee in the percentage of a new borrowing
     * @param _lateFeeFlat flat fee portion of the late
     * @param _lateFeeBps a fee in the percentage of the outstanding balance
     * @dev Only owner can make this setting
     */
    function setFees(
        uint256 _frontLoadingFeeFlat,
        uint256 _frontLoadingFeeBps,
        uint256 _lateFeeFlat,
        uint256 _lateFeeBps,
        uint256 _membershipFee
    ) external {}

    /**
     * @notice Sets the min percentage of principal to be paid in each billing period
     * @param _minPrincipalRateInBps the min % in unit of bps. For example, 5% will be 500
     * @dev Only owner can make this setting
     * @dev This is a global limit of 5000 bps (50%).
     */
    function setMinPrincipalRateInBps(uint256 _minPrincipalRateInBps) external {}

    /// @inheritdoc ICreditFeeManager
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc
    )
        public
        view
        virtual
        override
        returns (CreditRecord memory newCreditRecord, uint256 periodsPassed, bool isLate)
    {
        //* Reserved for Richard review, to be deleted, please review this function

        PoolSettings memory settings = poolConfig.getPoolSettings();
        // If the due is nonzero and has passed late payment grace period, the account is considered late
        isLate = (_cr.totalDue != 0 &&
            block.timestamp >
            _cr.nextDueDate + settings.latePaymentGracePeriodInDays * SECONDS_IN_A_DAY);

        // Directly return if it is still within the current period or within late payment grace
        // period when there is still a balance due
        if ((block.timestamp <= _cr.nextDueDate) || (_cr.totalDue != 0 && !isLate)) {
            return (_cr, 0, false);
        }

        /**
         * Loop through the passed periods to generate bills for each whole period
         * (except the last one if the current timestamp == the next due date) following these steps:
         * 1. Calculate late fee if it is past due
         * 2. Compute yield for the next period
         * 3. Add membership fee
         * 4. Calculate the principal due, and subtract it from the unbilled principal amount
         */
        newCreditRecord = CreditRecord(
            _cr.unbilledPrincipal,
            _cr.nextDueDate,
            _cr.totalDue,
            _cr.yieldDue,
            _cr.feesDue,
            _cr.missedPeriods,
            _cr.remainingPeriods,
            _cr.state
        );
        uint256 currentPeriodInSeconds;
        uint256 totalMissedPeriods = _cr.missedPeriods;
        while (block.timestamp > newCreditRecord.nextDueDate) {
            uint256 newNextDueDate = calendar.getNextPeriod(
                _cc.periodDuration,
                newCreditRecord.nextDueDate
            );
            currentPeriodInSeconds = newCreditRecord.nextDueDate > 0
                ? newNextDueDate - newCreditRecord.nextDueDate
                : newNextDueDate - block.timestamp;

            // Step 1. calculate late fees
            if (newCreditRecord.totalDue > 0) {
                newCreditRecord.unbilledPrincipal += newCreditRecord.totalDue;
                newCreditRecord.feesDue = uint96(calcLateFee(newCreditRecord.unbilledPrincipal));
            }

            // Step 2. compute the yield for the next period
            newCreditRecord.yieldDue = uint96(
                (newCreditRecord.unbilledPrincipal * _cc.yieldInBps * currentPeriodInSeconds) /
                    (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            );

            // console.log("cr.yieldDue: %s, _cc.yieldInBps: %s", cr.yieldDue, _cc.yieldInBps);

            // Step 3. handle membership fee.
            (, , uint256 membershipFee) = poolConfig.getFees();
            newCreditRecord.feesDue += uint96(membershipFee);

            // console.log("cr.feesDue: %s, membershipFee: %s", cr.feesDue, membershipFee);

            // Step 4. compute principal due and adjust unbilled principal
            uint256 principalDue = (newCreditRecord.unbilledPrincipal *
                poolConfig.getMinPrincipalRateInBps()) / HUNDRED_PERCENT_IN_BPS;
            newCreditRecord.totalDue = uint96(
                newCreditRecord.feesDue + newCreditRecord.yieldDue + principalDue
            );
            newCreditRecord.unbilledPrincipal = uint96(
                newCreditRecord.unbilledPrincipal - principalDue
            );

            periodsPassed++;
            totalMissedPeriods++;
            newCreditRecord.nextDueDate = uint64(newNextDueDate);

            if (
                (totalMissedPeriods - 1) * settings.payPeriodInMonths >
                settings.defaultGracePeriodInMonths
            ) {
                // If the borrower has missed more than default grace periods, the credit line is defaulted
                // and stops to accrue interest.
                break;
            }
        }

        // If passed final period, all principal is due
        if (periodsPassed >= newCreditRecord.remainingPeriods) {
            newCreditRecord.totalDue += newCreditRecord.unbilledPrincipal;
            newCreditRecord.unbilledPrincipal = 0;
        }
    }
}
