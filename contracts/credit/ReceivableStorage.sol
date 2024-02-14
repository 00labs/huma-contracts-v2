// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {ReceivableInfo} from "./CreditStructs.sol";
import {CountersUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";

contract ReceivableStorage {
    using CountersUpgradeable for CountersUpgradeable.Counter;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    CountersUpgradeable.Counter internal _tokenIdCounter;

    // Map token ID to receivable information
    mapping(uint256 => ReceivableInfo) public receivableInfoMap;

    // The original owner of the receivable often has an internal reference id. Map it to token ID.
    mapping(bytes32 => uint256) public referenceIdHashToTokenId;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
