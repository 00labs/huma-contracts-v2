// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {EpochInfo} from "./interfaces/IEpoch.sol";

contract TrancheVaultStorage {
    struct RedemptionRequest {
        // The ID of the epoch where this redemption request was submitted
        uint64 epochId;
        // The number of shares requested for redemption
        uint96 numSharesRequested;
    }

    struct RedemptionDisbursementInfo {
        // an index of user redemption requests array, withdrawable amounts should be calculated from this request
        uint64 requestsIndex;
        uint96 partialSharesProcessed;
        uint96 partialAmountProcessed;
    }

    IERC20 public underlyingToken;
    IPool public pool;
    IPoolVault public poolVault;
    IEpochManager public epochManager;
    uint8 internal _decimals;
    // Senior or junior tranche index
    uint8 public trancheIndex;

    // The IDs of all epochs where there is at least one redemption request.
    // Note that the index may not be contiguous: if there is no redemption request then the ID won't be recorded
    // in this array.
    uint256[] public epochIds;
    mapping(uint256 => EpochInfo) public epochInfoByEpochId;
    // The index of the epoch ID whose corresponding epoch is unprocessed/partially processed.
    // We cache the index so that we don't have to traverse through all epoch IDs to figure out which ones
    // haven't been fully processed yet.
    uint256 public firstUnprocessedEpochIndex;

    mapping(address => RedemptionRequest[]) public redemptionRequestsByLender;
    mapping(address => RedemptionDisbursementInfo) public redemptionDisbursementInfoByLender;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
