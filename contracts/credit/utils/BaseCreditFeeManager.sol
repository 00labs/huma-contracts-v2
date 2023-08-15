// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditFeeManager} from "./interfaces/ICreditFeeManager.sol";
import {CreditConfig, CreditRecord, CreditState} from "../CreditStructs.sol";
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
            uint96 feesDue,
            uint96 yieldDue,
            uint96 totalDue,
            uint96 unbilledPrincipal,
            uint96 pnlImpact,
            uint96 principalDifference
        )
    {
        // Directly returns if it is still within the current period
        if (block.timestamp <= _cr.nextDueDate) {
            return (0, _cr.feesDue, _cr.yieldDue, _cr.totalDue, _cr.unbilledPrincipal, 0, 0);
        }

        // Computes how many billing periods have passed.
        if (_cr.state == CreditState.Approved) {
            periodsPassed = 1;
        } else {
            (, periodsPassed) = calendar.getNextDueDate(
                _cc.calendarUnit,
                _cc.periodDuration,
                _cr.nextDueDate
            );
        }

        /**
         * Loops through the passed periods to generate bills for each period following these steps:
         * 1. Calcuates late fee if it is past due
         * 2. Computes yield for the next period
         * 3. Adds membership fee
         * 4. Calculates the principal due, and minus it from the unbilled principal amount
         * 5. Computes the under-reported profit if there is late fee thus increased principal
         */
        uint256 secondsPerPeriod = calendar.getSecondsPerPeriod(
            _cc.calendarUnit,
            _cc.periodDuration
        );

        for (uint256 i = 0; i < periodsPassed; i++) {
            // step 1. calculates late fees
            if (_cr.totalDue > 0) {
                _cr.unbilledPrincipal += _cr.totalDue;
                principalDifference += _cr.totalDue;
                _cr.feesDue = uint96(calcLateFee(_cr.unbilledPrincipal + _cr.totalDue));
            }

            // step 2. computes yield for the next period
            _cr.yieldDue = uint96(
                (((_cr.unbilledPrincipal * _cc.yieldInBps) / HUNDRED_PERCENT_IN_BPS) *
                    secondsPerPeriod) / SECONDS_IN_A_YEAR
            );

            // step 3. handles membership fee.
            (, , uint256 membershipFee) = poolConfig.getFees();
            _cr.yieldDue += uint96(membershipFee);

            // step 4. computes principal due and adjust unbilled principal
            uint256 principalToBill = (_cr.unbilledPrincipal *
                poolConfig.getMinPrincipalRateInBps()) / HUNDRED_PERCENT_IN_BPS;
            _cr.totalDue = uint96(_cr.feesDue + _cr.yieldDue + principalToBill);
            _cr.unbilledPrincipal = uint96(_cr.unbilledPrincipal - principalToBill);

            // Step 5. captures undercounted profit for this period.
            pnlImpact += uint96(
                (principalDifference * _cc.yieldInBps * secondsPerPeriod) / SECONDS_IN_A_YEAR
            );
        }

        // If passed final period, all principal is due
        if (periodsPassed >= _cr.remainingPeriods) {
            _cr.totalDue += _cr.unbilledPrincipal;
            _cr.unbilledPrincipal = 0;
        }

        return (
            periodsPassed,
            _cr.feesDue,
            _cr.yieldDue,
            _cr.totalDue,
            _cr.unbilledPrincipal,
            pnlImpact,
            principalDifference
        );
    }
}
