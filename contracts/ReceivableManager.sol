// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IDealManager} from "./IDealManager.sol";
import {DealConfig} from "./DealStructs.sol";

struct ReceivableParam {
    address receivableAsset;
    uint96 receivableAmount;
    uint256 receivableId;
    bytes receivableData;
}

struct ReceivableInfo {
    address receivableAsset;
    uint96 receivableAmount;
    uint256 receivableId;
    bytes32 receivableDataHash;
}

abstract contract ReceivableManager {
    IDealManager public dealManager;

    mapping(bytes32 => ReceivableInfo) public dealReceivables;

    function validateAndTransfer(
        bytes32 dealHash,
        address borrower,
        uint256 borroweAmount,
        ReceivableInfo memory receivableInfo
    ) internal virtual;

    function validateAndMint(
        bytes32 dealHash,
        address borrower,
        uint256 borroweAmount,
        ReceivableInfo memory receivableInfo,
        bytes calldata mintData
    ) internal virtual returns (uint256 receivableId);

    function approveDeal(
        address borrower,
        uint256 dealPrincipal,
        DealConfig calldata dealConfig,
        ReceivableParam memory receivableParam
    ) external returns (bytes32 dealHash) {
        onlyEAServiceAccount();

        // check receivable parameters
        dealHash = keccak256(abi.encode(borrower, dealPrincipal, receivableParam));
        // create & store receivable info

        dealManager.approveDeal(dealHash, borrower, dealPrincipal, dealConfig);
    }

    function drawdown(bytes32 dealHash, uint256 borrowAmount) external {
        // check parameters
        ReceivableInfo memory receivableInfo = dealReceivables[dealHash];
        validateAndTransfer(dealHash, msg.sender, borrowAmount, receivableInfo);

        dealManager.drawdown(dealHash, borrowAmount);
    }

    function mintAndDrawdown(
        bytes32 dealHash,
        uint256 borrowAmount,
        bytes calldata mintData
    ) external {
        // check parameters
        ReceivableInfo memory receivableInfo = dealReceivables[dealHash];
        uint256 receivableId = validateAndMint(
            dealHash,
            msg.sender,
            borrowAmount,
            receivableInfo,
            mintData
        );
        dealReceivables[dealHash].receivableId = receivableId;

        dealManager.drawdown(dealHash, borrowAmount);
    }

    function onlyEAServiceAccount() internal view {}
}
