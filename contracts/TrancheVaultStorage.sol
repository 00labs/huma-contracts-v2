// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {EpochInfo} from "./interfaces/IEpoch.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TrancheVaultStorage {
    struct RedemptionInfo {
        // The index of epochIds array
        uint64 indexOfEpochIds;
        // The number of shares requested for redemption in this epoch
        uint96 numSharesRequested;
        // The total amount processed for redemption in all epochs
        uint96 totalAmountProcessed;
        // The total amount withdrawn by the lender, the withdrawable amount = totalAmountProcessed - totalAmountWithdrawn
        uint96 totalAmountWithdrawn;
    }

    IERC20 public underlyingToken;
    uint8 internal _decimals;
    // Senior or junior tranche index
    uint8 public trancheIndex;

    IPool public pool;
    IPoolSafe public poolSafe;
    IEpochManager public epochManager;

    // The IDs of all epochs where there is at least one redemption request.
    // Note that the index may not be contiguous: if there is no redemption request,
    // the ID won't be recorded in this array.
    uint256[] public epochIds;
    mapping(uint256 => EpochInfo) public epochInfoByEpochId;

    mapping(address => RedemptionInfo) public redemptionInfoByLender;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
