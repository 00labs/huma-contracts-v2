// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, DueDetail} from "../../CreditStructs.sol";
import {PayPeriodDuration} from "../../../common/SharedDefs.sol";

/**
 * @notice ICreditDueManager.sol defines functions to compute credit-related fees
 */

interface ICreditDueManager {
    /**
     * @notice Apply front loading fee, distribute the total amount to borrower, pool, & protocol
     * @param borrowAmount the amount of the borrowing
     * @return amtToBorrower the amount that the borrower can take
     * @return platformFees the platform charges
     * @dev the protocol always takes a percentage of the total fee generated
     */
    function distBorrowingAmount(
        uint256 borrowAmount
    ) external view returns (uint256 amtToBorrower, uint256 platformFees);

    /**
     * @notice Computes the front loading fee, which is also known as origination fee.
     * @param _amount the borrowing amount
     * @return fees the amount of fees to be charged for this borrowing
     */
    function calcFrontLoadingFee(uint256 _amount) external view returns (uint256 fees);

    function getNextBillRefreshDate(
        CreditRecord memory cr
    ) external view returns (uint256 refreshDate);

    function refreshLateFee(
        CreditRecord memory _cr,
        DueDetail memory _dd,
        PayPeriodDuration periodDuration,
        uint256 committedAmount,
        uint256 timestamp
    ) external view returns (uint64 lateFeeUpdatedDate, uint96 lateFee);

    /**
     * @notice Gets the current total due, fees and yield due, and payoff amount.
     * Because there is no "cron" kind of mechanism, it is possible that the account is behind
     * for multiple cycles due to lack of activities. This function will traverse through
     * these cycles to get the most up-to-date due information.
     * @dev This is a view only function, it does not update the account status. It is used to
     * help the borrowers to get their balances without paying gases.
     * @dev The difference between nextDue and yieldDue is the required principal payment.
     * @param cr The credit record associated with the account.
     * @param cc The credit config associated with with account.
     * @param dd The due details associated with the account.
     * @param timestamp The timestamp at which the due info should be computed.
     */
    function getDueInfo(
        CreditRecord memory cr,
        CreditConfig memory cc,
        DueDetail memory dd,
        uint256 timestamp
    ) external view returns (CreditRecord memory newCR, DueDetail memory newDD);

    function getPayoffAmount(CreditRecord memory cr) external view returns (uint256 payoffAmount);

    /**
     * @notice Returns the additional yield accrued and principal due for the amount being drawn down.
     * @param periodDuration The pay period duration
     * @param borrowAmount The amount being drawndown
     * @param nextDueDate The next due date of the bill
     * @param yieldInBps The APY expressed in BPs
     */
    function computeAdditionalYieldAccruedAndPrincipalDueForDrawdown(
        PayPeriodDuration periodDuration,
        uint256 borrowAmount,
        uint256 nextDueDate,
        uint256 yieldInBps
    ) external view returns (uint256 additionalYieldAccrued, uint256 additionalPrincipalDue);

    /**
     * @notice Returns the difference in yield due to the value that the yield is calculated from changed from the old
     * value to the new value.
     */
    function computeUpdatedYieldDue(
        uint256 nextDueDate,
        uint256 oldYield,
        uint256 oldValue,
        uint256 newValue,
        uint256 principal
    ) external view returns (uint256 updatedYield);
}
