// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditRecord, DueDetail} from "../CreditStructs.sol";

interface ICreditLine {
    /**
     * @notice Allows the borrower to borrow against an approved credit line.
     * @param borrower Address of the borrower.
     * @param borrowAmount The amount to borrow.
     * @return netAmountToBorrower The net amount disbursed to the borrower.
     * @custom:access Only the owner of the credit line can drawdown.
     */
    function drawdown(
        address borrower,
        uint256 borrowAmount
    ) external returns (uint256 netAmountToBorrower);

    /**
     * @notice Makes one payment for the credit line. This can be initiated by the borrower
     * or by sentinelServiceAccount with the allowance approval from the borrower.
     * If this is the final payment, it automatically triggers the payoff process.
     * @notice Warning: payments should be made by calling this function. No token should be transferred directly
     * to the contract.
     * @param borrower The address of the borrower.
     * @param amount The payment amount.
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     * @custom:access Only the borrower and the Sentinel Service can call this function.
     */
    function makePayment(
        address borrower,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    /**
     * @notice Makes a payment towards the principal for the credit line. Even if there is additional amount remaining
     * after the principal is paid off, this funtion will only accept the amount up to the total principal due.
     * If this is the final payment, it automatically triggers the payoff process.
     * @notice Warning: payments should be made by calling this function. No token should be transferred directly
     * to the contract.
     * @param borrower The address of the borrower.
     * @param amount The payment amount.
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     * @custom:access Only the borrower and the Sentinel Service can call this function.
     */
    function makePrincipalPayment(
        address borrower,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    /**
     * @notice Returns the date that the bill should be refreshed.
     * @param borrower The address of the borrower.
     * @return refreshDate The date that the bill should be refreshed.
     */
    function getNextBillRefreshDate(address borrower) external view returns (uint256 refreshDate);

    /**
     * @notice Returns the bill with up-to-date due info.
     * @param borrower The address of the borrower.
     * @return cr The new `CreditRecord` with updated due information.
     * @return dd The dew `DueDetail` with updated due information.
     */
    function getDueInfo(
        address borrower
    ) external view returns (CreditRecord memory cr, DueDetail memory dd);
}
