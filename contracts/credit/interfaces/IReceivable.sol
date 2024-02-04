// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {ReceivableInfo, ReceivableState} from "../CreditStructs.sol";

interface IReceivable {
    /**
     * @notice Creates a new receivable token and assigns it to the recipient address.
     * @param currencyCode The ISO 4217 currency code that the receivable is denominated in.
     * @param receivableAmount The total amount of the receivable.
     * @param maturityDate The date on which the receivable becomes due.
     * @param referenceId A unique internal reference ID to be used for de-duping purposes for the creatorl.
     * @param uri The URI of the metadata associated with the receivable.
     * @custom:access Anyone can call this function.
     */
    function createReceivable(
        uint16 currencyCode,
        uint96 receivableAmount,
        uint64 maturityDate,
        string memory referenceId,
        string memory uri
    ) external returns (uint256 tokenId);

    /**
     * @notice Declares a payment for a receivable.
     * The payment method for the receivable must be Declarative.
     * @param tokenId The ID of the receivable token.
     * @param paymentAmount The amount of payment being declared.
     * @custom:access Only the owner or the original creator of the token can declare a payment.
     */
    function declarePayment(uint256 tokenId, uint96 paymentAmount) external;

    /**
     * @notice Returns the receivable associated with the given `tokenId`.
     * @param tokenId The ID of the receivable token.
     * @return receivable The receivable.
     */
    function getReceivable(
        uint256 tokenId
    ) external view returns (ReceivableInfo memory receivable);

    /**
     * @notice Returns the payment status of a receivable.
     * Returns `Status.Paid` if the receivable has been paid in full.
     * Returns `Status.PartiallyPaid` if the receivable has been paid partially.
     * Returns `Status.Unpaid` if the receivable has not been paid at all.
     * @param tokenId The ID of the receivable token.
     * @return state The payment status of the receivable.
     */
    function getStatus(uint256 tokenId) external view returns (ReceivableState state);

    /**
     * @notice Returns the reference ID hash, which is a key
     * for lookup in the `tokenIds` mapping. Helpful for minters
     * who want to obtain the token id given their internal unique reference ID.
     * @param referenceId The ID that the receivable creator assigned to identify the receivable token
     * on their side.
     * @param creator The original creator of the receivable token.
     * @return The hashed value of the referenceId and creator address.
     */
    function getReferenceIdHash(
        string memory referenceId,
        address creator
    ) external view returns (bytes32);
}
