// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableInfo, ReceivableManager} from "./ReceivableManager.sol";

contract SuperfluidProcessor is ReceivableManager {
    function validateAndTransfer(
        bytes32 dealHash,
        address borrower,
        uint256 borroweAmount,
        ReceivableInfo memory receivableInfo
    ) internal override {
        revert();
    }

    function validateAndMint(
        bytes32 dealHash,
        address borrower,
        uint256 borroweAmount,
        ReceivableInfo memory receivableInfo,
        bytes calldata mintData
    ) internal override returns (uint256 receivableId) {}

    function makePayment(bytes32 dealHash) external {
        // check parameter
        // prepare payment assets
        // call dealManager.makePayment
        // handle receivable
    }
}
