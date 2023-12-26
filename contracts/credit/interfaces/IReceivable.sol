// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {ReceivableInfo, ReceivableState} from "../CreditStructs.sol";

interface IReceivable {
    /**
     * @notice Creates a new receivable token and assigns it to the recipient address
     * @param currencyCode The ISO 4217 currency code that the receivable is denominated in
     * @param receivableAmount The total amount of the receivable
     * @param maturityDate The date at which the receivable becomes due
     * @param uri The URI of the metadata associated with the receivable
     */
    function createReceivable(
        uint16 currencyCode,
        uint96 receivableAmount,
        uint64 maturityDate,
        string memory uri
    ) external returns (uint256 tokenId);

    /**
     * @notice Creates a new receivable token which represents an important lifecycle update
     * to an existing receivable and assigns it to the recipient address
     * @dev The receivable created by this function should always have a `ReceivableState` of `Update`
     * @param originalReceivableTokenId The tokenId of the original existing receivable that
     * this update is associated with. This tokenId must exist and must be owner by or created
     * by the caller.
     * @param uri The URI of the metadata associated with the receivable update
     */
    function createReceivableUpdate(
        uint256 originalReceivableTokenId,
        string memory uri
    ) external returns (uint256 tokenId);

    /**
     * @notice Declares payment for a receivable.
     * The payment method for the receivable must be Declarative.
     * The receivable must not already be paid in full.
     * @custom:access Only the owner or the original creator of the token can declare a payment.
     * @param tokenId The ID of the receivable token.
     * @param paymentAmount The amount of payment being declared.
     */
    function declarePayment(uint256 tokenId, uint96 paymentAmount) external;

    /**
     * @notice Returns the receivable associated with the given `tokenId`.
     * @param tokenId The ID of the receivable token.
     * @return receivable The receivable.
     */
    function getReceivable(uint256 tokenId) external returns (ReceivableInfo memory receivable);

    /**
     * @notice Gets the payment status of a receivable.
     * Returns `Status.Paid` if the receivable has been paid in full.
     * Returns `Status.PartiallyPaid` if the receivable has been paid partially.
     * Returns `Status.Unpaid` if the receivable has not been paid at all.
     * @param tokenId The ID of the receivable token.
     * @return state The payment status of the receivable.
     */
    function getStatus(uint256 tokenId) external returns (ReceivableState state);
}
