// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditFeeManager} from "./interfaces/ICreditFeeManager.sol";
import {CreditConfig, CreditRecord} from "../CreditStructs.sol";
import {PoolConfig} from "../../PoolConfig.sol";
import {ICalendar} from "../interfaces/ICalendar.sol";
import "../../SharedDefs.sol";
import {Errors} from "../../Errors.sol";

contract BaseCreditFeeManager is ICreditFeeManager {
    ICalendar public calendar;
    PoolConfig public poolConfig;

    /**
     * @notice Compute interest and principal 
     */
    function accruedDebt(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        CreditRecord memory dealRecord
    ) external view virtual returns (uint256 accruedInterest, uint256 accruedPrincipal) {

    }

    /**
     * @notice Computes the late fee including both the flat fee and percentage fee
     * @param dueDate the due date of the payment
     * @param totalDue the amount that is due
     * @param totalBalance the total balance including amount due and unbilled principal
     * @return fees the amount of late fees to be charged
     * @dev Charges only if 1) there is outstanding due, 2) the due date has passed
     */
    function calcLateFee(
        uint256 dueDate,
        uint256 totalDue,
        uint256 totalBalance
    ) public view virtual override returns (uint256 fees) {
        if (block.timestamp > dueDate && totalDue > 0) {
            uint256 lateFeeBps;
            (fees, lateFeeBps, ) = poolConfig.getFees();

            if (lateFeeBps > 0) fees += (totalBalance * lateFeeBps) / HUNDRED_PERCENT_IN_BPS;
        }
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
        (fees, frontLoadingFeeBps) = poolConfig.getFrontLoadingFee();
        if (frontLoadingFeeBps > 0)
            fees += (_amount * frontLoadingFeeBps) / HUNDRED_PERCENT_IN_BPS;
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

    /**
     * @notice Gets the current total due, fees and interest due, and payoff amount.
     * Because there is no "cron" kind of mechanism, it is possible that the account is behind
     * for multiple cycles due to a lack of activities. This function will traverse through
     * these cycles to get the most up-to-date due information.
     * @dev This is a view only function, it does not update the account status. It is used to
     * help the borrowers to get their balances without paying gases.
     * @dev the difference between totalDue and feesAndInterestDue is required principal payment
     * @dev payoffAmount is good until the next statement date. It includes the interest for the
     * entire current/new billing period. We will ask for allowance of the total payoff amount,
     * but if the borrower pays off before the next due date, we will subtract the interest saved
     * and only transfer an amount lower than the original payoff estimate.
     * @dev please note the first due date is set after the initial drawdown. All the future due
     * dates are computed by adding multiples of the payment interval to the first due date.
     * @param _cr the credit record associated the account
     * @return periodsPassed the number of billing periods has passed since the last statement.
     * If it is within the same period, it will be 0.
     * @return feesAndInterestDue the sum of fees and interest due. If multiple cycles have passed,
     * this amount is not necessarily the total fees and interest charged. It only returns the amount
     * that is due currently.
     * @return totalDue amount due in this period, it includes fees, interest, and min principal
     */
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc
    )
        public
        view
        virtual
        override
        returns (
            uint256 periodsPassed,
            uint96 feesAndInterestDue,
            uint96 totalDue,
            uint96 unbilledPrincipal,
            int96 totalCharges
        )
    {
        // Directly returns if it is still within the current period
        if (block.timestamp <= _cr.nextDueDate) {
            return (0, _cr.feesAndInterestDue, _cr.totalDue, _cr.unbilledPrincipal, 0);
        }

        // Computes how many billing periods have passed. 1+ is needed since Solidity always
        // round to zero. When it is exactly at a billing cycle, it is desirable to 1+ as well
        if (_cr.nextDueDate > 0) {
            periodsPassed =
                1 + calendar.getNumberOfPeriodsPassed(_cc.calendarUnit, _cc.periodDuration, _cr.nextDueDate);
            // No credit line has more than 360 periods. If it is longer than that, something
            // is wrong. Set it to 361 so that the non view function can emit an event.
            if (periodsPassed >= MAX_PERIODS)  periodsPassed = MAX_PERIODS;
        } else {
            periodsPassed = 1;
        }

        /**
         * Loops through the cycles as we would generate statements for each cycle.
         * The logic for each iteration is as follows:
         * 1. Calcuate late fee if it is past due based on outstanding principal and due
         * 2. Add membership fee
         * 3  Add outstanding due amount and corrections to the unbilled principal
         *    as the new base for principal
         * 4. Calcuate interest for this new cycle using the new principal
         * 5. Calculate the principal due, and minus it from the unbilled principal amount
         */
        uint256 fees = 0;
        uint256 interest = 0;

        for (uint256 i = 0; i < periodsPassed; i++) {
            // step 1. late fee calculation
            if (_cr.totalDue > 0)
                fees = calcLateFee(
                    _cr.nextDueDate + i * _cc.periodDuration * SECONDS_IN_A_DAY,
                    _cr.totalDue,
                    _cr.unbilledPrincipal + _cr.totalDue
                );

            // step 2. membership fee
            // todo change to share reading fees with late fee
            (,, uint256 membershipFee) = poolConfig.getFees();
            fees += membershipFee;

            // step 3. adding dues to principal
            _cr.unbilledPrincipal += _cr.totalDue;

            // step 4. compute interest
            interest =
                (_cr.unbilledPrincipal * _cc.yieldInBps * _cc.periodDuration * SECONDS_IN_A_DAY) /
                SECONDS_IN_A_YEAR /
                HUNDRED_PERCENT_IN_BPS;

            // step 5. compute principal due and adjust unbilled principal
            uint256 principalToBill = (_cr.unbilledPrincipal *
                poolConfig.getMinPrincipalRateInBps()) / HUNDRED_PERCENT_IN_BPS;
            _cr.feesAndInterestDue = uint96(fees + interest);
            totalCharges += int96(uint96(fees + interest));
            _cr.totalDue = uint96(fees + interest + principalToBill);
            _cr.unbilledPrincipal = uint96(_cr.unbilledPrincipal - principalToBill);
        }

        // If passed final period, all principal is due
        if (periodsPassed >= _cr.remainingPeriods) {
            _cr.totalDue += _cr.unbilledPrincipal;
            _cr.unbilledPrincipal = 0;
        }

        return (
            periodsPassed,
            _cr.feesAndInterestDue,
            _cr.totalDue,
            _cr.unbilledPrincipal,
            totalCharges
        );
    }
}
