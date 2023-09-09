// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {EpochInfo} from "./interfaces/IEpoch.sol";

contract TrancheVaultStorage {
    struct UserRedemptionRequest {
        uint64 epochId; // the epochId of EpochInfo
        uint96 shareRequested; // the requested shares to redeem
    }

    struct UserDisburseInfo {
        // an index of user redemption requests array, withdrawable amounts should be calculated from this request
        uint64 requestsIndex;
        uint96 partialShareProcessed;
        uint96 partialAmountProcessed;
    }

    IERC20 public underlyingToken;
    IPool public pool;
    IPoolVault public poolVault;
    IEpochManager public epochManager;
    uint8 internal _decimals;
    uint8 public trancheIndex; // senior index or junior index

    uint256[] public epochIds; // the epoch id array
    mapping(uint256 => EpochInfo) public epochMap; // key is epochId
    uint256 public unprocessedIndexOfEpochIds; // the index of the epoch id from which is not fully processed

    mapping(address => UserRedemptionRequest[]) public userRedemptionRequests; // user redemption request array
    mapping(address => UserDisburseInfo) public userDisburseInfos;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
