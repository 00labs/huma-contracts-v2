// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {CreditConfig, CreditRecord, DueDetail} from "../CreditStructs.sol";
import {PayPeriodDuration} from "../../common/SharedDefs.sol";

/**
 * @notice ICreditDueManager.sol defines functions to compute credit-related fees
 */

interface ICreditDueManager {
    /**
     * @notice Applies the front loading fee and returns the amount that should be distributed to borrower,
     * pool & protocol.
     * @notice The protocol always takes a percentage of the total fee generated.
     * @param borrowAmount The amount of the borrowing.
     * @return amtToBorrower The amount that the borrower can take.
     * @return platformFees The platform charges.
     */
    function distBorrowingAmount(
        uint256 borrowAmount
    ) external view returns (uint256 amtToBorrower, uint256 platformFees);

    /**
     * @notice Computes the front loading fee, which is also known as origination fee.
     * @param _amount The borrowing amount.
     * @return fees The amount of fees to be charged for this borrowing.
     */
    function calcFrontLoadingFee(uint256 _amount) external view returns (uint256 fees);

    /**
     * @notice Returns the date the bill should be refreshed.
     * @param cr The CreditRecord associated with the account.
     * @return refreshDate The date the bill should be refreshed.
     */
    function getNextBillRefreshDate(
        CreditRecord memory cr
    ) external view returns (uint256 refreshDate);

    /**
     * @notice Returns the updated late fee for a bill that's late.
     * @param _cr The CreditRecord associated with the account.
     * @param _dd The DueDetail associated with the account.
     * @param periodDuration The pay period duration.
     * @param committedAmount The committed amount of the credit.
     * @param timestamp The timestamp until when the late fee should be calculated.
     * @return lateFeeUpdatedDate When the late fee should be updated until. This should be the end of the day
     * `timestamp` is in.
     * @return lateFee The updated late fee.
     */
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
     * @param cr The CreditRecord associated with the account.
     * @param cc The CreditConfig associated with with account.
     * @param dd The DueDetail associated with the account.
     * @param timestamp The timestamp at which the due info should be computed.
     * @return newCR The new CreditRecord with updated due information.
     * @return newDD The dew DueDetail with updated due information.
     */
    function getDueInfo(
        CreditRecord memory cr,
        CreditConfig memory cc,
        DueDetail memory dd,
        uint256 timestamp
    ) external view returns (CreditRecord memory newCR, DueDetail memory newDD);

    /**
     * @notice Returns the payoff amount for the bill.
     * @param cr The CreditRecord associated with the account.
     * @return payoffAmount The amount needed to pay off the bill.
     */
    function getPayoffAmount(CreditRecord memory cr) external view returns (uint256 payoffAmount);

    /**
     * @notice Returns the additional yield accrued and principal due for the amount being drawn down.
     * @param periodDuration The pay period duration.
     * @param borrowAmount The amount being drawn down.
     * @param nextDueDate The next due date of the bill.
     * @param yieldInBps The APY expressed in BPs.
     * @return additionalYieldAccrued The additional accrued yield due to the drawdown.
     * @return additionalPrincipalDue The additional principal due from the amount being drawn down.
     */
    function computeAdditionalYieldAccruedAndPrincipalDueForDrawdown(
        PayPeriodDuration periodDuration,
        uint256 borrowAmount,
        uint256 nextDueDate,
        uint256 yieldInBps
    ) external view returns (uint256 additionalYieldAccrued, uint256 additionalPrincipalDue);
}
