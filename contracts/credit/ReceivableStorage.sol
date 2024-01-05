// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableInfo} from "./CreditStructs.sol";
import {CountersUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";

contract ReceivableStorage {
    using CountersUpgradeable for CountersUpgradeable.Counter;

    // This is the keccak-256 hash of "MINTER_ROLE"
    bytes32 public constant MINTER_ROLE =
        0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6;
    CountersUpgradeable.Counter internal _tokenIdCounter;

    // Map tokenId to receivable information
    mapping(uint256 => ReceivableInfo) public receivableInfoMap;

    // Map tokenId to the address of the creator of the receivable
    mapping(uint256 => address) public creators;

    mapping(bytes32 => uint256) public referenceIdHashToTokenId;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
