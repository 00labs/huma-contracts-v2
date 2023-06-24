// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPool} from "./interfaces/IPool.sol";
import {ITrancheVault, EpochInfo} from "./interfaces/ITrancheVault.sol";

interface IEpochManagerLike {
    function currentEpochId() external returns (uint256);
}

struct UserWithdrawalRequest {
    uint64 epochId;
    uint96 withdrawalAmount; // the requested redeem amount
}

struct UserWithdrawalInfo {
    uint64 currentIndex;
    uint96 totalRequestedAmount;
    uint96 totalWithdrawableAmount;
}

contract TrancheVault is ERC20, ITrancheVault {
    IEpochManagerLike public epochManager;
    IPool public pool;
    uint256 public index; // senior index or junior index

    EpochInfo[] public epochs; // the epoch info array
    mapping(uint256 => EpochInfo) public epochMapping;
    uint256 public currentEpochIndex; // the index of the last fully processed epoch

    mapping(address => UserWithdrawalRequest[]) public userWithdrawalRequests; // user withdrawal request array
    mapping(address => UserWithdrawalInfo) public userWithdrawalInfos;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /**
     * @notice Returns all unprocessed epochs.
     */
    function unprocessedEpochInfos() external view override returns (EpochInfo[] memory result) {
        uint256 len = epochs.length - currentEpochIndex;
        result = new EpochInfo[](len);
        for (uint256 i; i < len; i++) {
            result[i] = epochs[currentEpochIndex + i];
        }
    }

    function totalSupply() public view override(ERC20, ITrancheVault) returns (uint256) {
        return ERC20.totalSupply();
    }

    /**
     * @notice Updates processed epochs
     */
    function closeEpoch(EpochInfo[] memory processedEpochs) external {
        // update epochs array
        // update currentEpochIndex
        // burn/lock vault tokens
        // withdraw underlying tokens from reserve
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        // verify cap

        uint96[2] memory tranches = pool.refreshPool();
        // get correct total assets based on tranche index
        uint256 totalAssets = tranches[index];

        // verify max senior ratio if it is senior vault

        uint256 price = totalAssets / ERC20.totalSupply();

        // calculate minted shares

        // transfer assets to reserve
        // mint shares to receiver
    }

    /**
     * @notice Adds withdrawal assets(underlying token amount) in current withdrawal request
     */
    function addWithdrawalRequest(uint256 assets) external {
        UserWithdrawalRequest[] storage requests = userWithdrawalRequests[msg.sender];
        UserWithdrawalRequest memory request = requests[requests.length - 1];
        uint256 epochId = epochManager.currentEpochId();
        if (request.epochId == epochId) {
            // add assets in current withdrawal request
            request.withdrawalAmount += uint96(assets);
            requests[requests.length - 1] = request;
        } else {
            // no withdrawal request, create a new one
            request.epochId = uint64(epochId);
            request.withdrawalAmount = uint96(assets);
            requests.push(request);
        }
    }

    /**
     * @notice Removes withdrawal assets(underlying token amount) from current withdrawal request
     */
    function removeWithdrawalRequest(uint256 assets) external {
        UserWithdrawalRequest[] storage requests = userWithdrawalRequests[msg.sender];
        UserWithdrawalRequest memory request = requests[requests.length - 1];
        uint256 epochId = epochManager.currentEpochId();
        if (request.epochId < epochId || request.withdrawalAmount < assets) {
            // only remove from current withdrawal request
            revert();
        }

        request.withdrawalAmount -= uint96(assets);
        requests[requests.length - 1] = request;
    }

    /**
     * @notice Transfers processed underlying tokens to the user
     */
    function disburse() external {
        UserWithdrawalInfo memory withdrawalInfo = _updateUserWithdrawable(msg.sender);
        // transfer totalWithdrawableAmount to user
        // set withdrawalInfo.totalWithdrawableAmount to 0
    }

    /**
     * @notice Calculates withdrawable amount from the last index of user withdrawal request array
     * to current processed user withdrawal request
     */
    function _updateUserWithdrawable(address user) internal returns (UserWithdrawalInfo memory) {
        UserWithdrawalInfo memory withdrawalInfo = userWithdrawalInfos[user];
        UserWithdrawalRequest[] storage requests = userWithdrawalRequests[msg.sender];
        EpochInfo memory ei = epochs[currentEpochIndex];

        // iterate processed withdrawal request from withdrawalInfo.currentIndex to ei.epochId (not included)
        // sum up processed withdrawalAmount and processed redeemShare
        // update withdrawalInfo.totalWithdrawableAmount
        // burn user's shares
    }
}
