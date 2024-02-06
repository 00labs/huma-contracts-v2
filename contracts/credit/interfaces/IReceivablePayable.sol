// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

interface IReceivablePayable {
    /**
     * @notice Makes one payment for the credit previously drawndown with the given receivable.
     * If this is the final payment, it automatically triggers the payoff process.
     * @notice Warning: payments should be made by calling this function. No token should be transferred directly
     * to the contract.
     * @param receivableId The ID of the receivable.
     * @param amount The payment amount.
     * @return amountPaid The actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff A flag indicating whether the account has been paid off.
     * @custom:access Only permitted payers for the credit can call this function.
     */
    function makePaymentWithReceivableByPayer(
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);
}
