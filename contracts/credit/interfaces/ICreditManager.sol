// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditConfig, CreditLimit} from "../CreditStructs.sol";

interface ICreditManager {
    function getCreditConfig(bytes32 creditHash) external view returns (CreditConfig memory);

    function onlyCreditBorrower(bytes32 creditHash, address borrower) external view;
}