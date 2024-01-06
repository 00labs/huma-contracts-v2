// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IReceivable} from "./interfaces/IReceivable.sol";

contract ReceivableBackedCreditLineManagerStorage {
    IReceivable public receivableAsset;

    /// Mapping from credit hash to the amount of available credit
    mapping(bytes32 => uint96) internal _availableCredits;

    /// Map tokenId to borrower
    mapping(uint256 => address) public receivableBorrowerMap;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
