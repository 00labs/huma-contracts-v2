// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig} from "./CreditStructs.sol";
import {BaseCredit} from "./BaseCredit.sol";

contract RevolvingCreditLine is BaseCredit {
    function approve(
        address borrower,
        uint256 creditLimit,
        CreditConfig calldata creditConfig
    ) external returns (bytes32 hash) {
        // only EA

        hash = keccak256(abi.encode(address(this), borrower));

        _approve(hash, borrower, creditLimit, creditConfig);
    }
}
