// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig} from "../CreditStructs.sol";
import {ICredit} from "./ICredit.sol";

struct ReceivableInfo {
    address receivableAsset;
    uint96 receivableAmount;
    uint256 receivableId;
}

interface IReceivableFactoring is ICredit {
    function approve(
        address borrower,
        uint256 creditLimit,
        CreditConfig calldata creditConfig,
        ReceivableInfo memory receivableInfo
    ) external returns (bytes32 hash);
}
