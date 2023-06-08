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

    function reviewPayment(bytes32 paymentHash, bool approved) external {
        // check parameters

        if (approved) {
            // call dealManager.makePayment(dealHash, amount);
        }
    }

    function markPaymentProcessed(bytes32 paymentHash) external {}
}
