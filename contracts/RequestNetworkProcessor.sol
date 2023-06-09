// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableInfo, ReceivableManager} from "./ReceivableManager.sol";

contract RequestNetworkProcessor is ReceivableManager {
    function validateAndTransfer(
        bytes32 dealHash,
        address borrower,
        uint256 borroweAmount,
        ReceivableInfo memory receivableInfo
    ) internal override {}

    function validateAndMint(
        bytes32 dealHash,
        address borrower,
        uint256 borroweAmount,
        ReceivableInfo memory receivableInfo,
        bytes calldata mintData
    ) internal override returns (uint256 receivableId) {
        revert();
    }

    function makePayment(bytes32 dealHash, uint256 amount, bytes32 paymentHash) external {
        // check parameters

        bool needReview;
        if (needReview) {
            // set flag to review
        } else {
            dealManager.makePayment(dealHash, amount);
        }
    }

    /**
     * @notice Reviews the payment hash if its amount is too big.
     * @param paymentHash payment hash
     * @param approved approved or not
     */
    function reviewPayment(bytes32 paymentHash, bool approved) external {
        // check parameters

        if (approved) {
            // call dealManager.makePayment(dealHash, amount);
        }
    }

    /**
     * @notice Marks the given payment is processed
     * @param paymentHash payment hash
     */
    function markPaymentProcessed(bytes32 paymentHash) external {}
}
