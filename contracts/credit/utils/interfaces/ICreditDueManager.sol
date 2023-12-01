// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, DueDetail} from "../../CreditStructs.sol";

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

    function refreshLateFee(
        CreditRecord memory _cr,
        DueDetail memory _dd
    ) external view returns (uint64 lateFeeUpdatedDate, uint96 lateFee);

    /**
     * @notice Gets the current total due, fees and yield due, and payoff amount.
     * Because there is no "cron" kind of mechanism, it is possible that the account is behind
     * for multiple cycles due to lack of activities. This function will traverse through
     * these cycles to get the most up-to-date due information.
     * @dev This is a view only function, it does not update the account status. It is used to
     * help the borrowers to get their balances without paying gases.
     * @dev the difference between nextDue and yieldDue is the required principal payment
     * @dev please note the first due date is set after the initial drawdown. All the future due
     * dates are computed by adding multiples of the payment interval to the first due date.
     * @param _cr the credit record associated with the account
     * @param _cc the credit config associated with with account
     * @param _dd the due details associated with the account
     */
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc,
        DueDetail memory _dd
    ) external view returns (CreditRecord memory newCR, DueDetail memory newDD, bool isLate);

    function getPayoffAmount(CreditRecord memory cr) external view returns (uint256 payoffAmount);
}
