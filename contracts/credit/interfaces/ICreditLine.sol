// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord} from "../CreditStructs.sol";

interface ICreditLine {
    /**
     * @notice Initiates a credit line with a committed amount on the designated start date.
     * This function is intended to be used for credit lines where there is a minimum borrowing
     * commitment. If the borrower fails to drawdown the committed amount within the set timeframe,
     * this function activates the credit line and applies yield based on the committed amount.
     * @param borrower Address of the borrower
     */
    function startCommittedCredit(address borrower) external;

    /**
     * @notice allows the borrower to borrow against an approved credit line.
     * @param borrower Address of the borrower
     * @param borrowAmount the amount to borrow
     * @dev Only the owner of the credit line can drawdown.
     */
    function drawdown(address borrower, uint256 borrowAmount) external;

    /**
     * @notice Makes one payment for the credit line. This can be initiated by the borrower
     * or by PDSServiceAccount with the allowance approval from the borrower.
     * If this is the final payment, it automatically triggers the payoff process.
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     * @notice Warning, payments should be made by calling this function. No token
     * should be transferred directly to the contract
     */
    function makePayment(
        address borrower,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    /**
     * @notice Makes a payment towards payment for the credit line. The payment is applied
     * towards principal only. Even if there is additional amount remaining after the
     * principal is mayff, this funtion will only accept the amount up to the total pirncipal due.
     * This can be initiated by the borrower or by PDSServiceAccount with the allowance
     * approval from the borrower.
     * If this is the final payment, it automatically triggers the payoff process.
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     * @notice Warning, payments should be made by calling this function
     * No token should be transferred directly to the contract
     */
    function makePrincipalPayment(
        address borrower,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);
}
