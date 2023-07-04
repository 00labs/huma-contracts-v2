// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPool} from "./interfaces/IPool.sol";
import {ITrancheVault, EpochInfo} from "./interfaces/ITrancheVault.sol";

interface IEpochManagerLike {
    function currentEpochId() external returns (uint256);
}

struct UserRedemptionRequest {
    uint64 epochId;
    uint96 RedemptionAmount; // the requested redeem amount
}

struct UserRedemptionInfo {
    uint64 currentIndex;
    uint96 totalRequestedAmount;
    uint96 totalWithdrawableAmount;
}

contract TrancheVault is ERC20, ITrancheVault {
    IERC20 public asset;
    IEpochManagerLike public epochManager;
    IPool public pool;
    uint256 public index; // senior index or junior index

    uint256[] public epochIds; // the epoch info array
    mapping(uint256 => EpochInfo) public epochMapping;
    uint256 public currentEpochIdsIndex; // the index of the epoch id currently being processed

    mapping(address => UserRedemptionRequest[]) public userRedemptionRequests; // user Redemption request array
    mapping(address => UserRedemptionInfo) public userRedemptionInfos;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /**
     * @notice Returns all unprocessed epochs.
     */
    function unprocessedEpochInfos() external view override returns (EpochInfo[] memory result) {
        uint256 len = epochIds.length - currentEpochIdsIndex;
        result = new EpochInfo[](len);
        for (uint256 i; i < len; i++) {
            result[i] = epochMapping[epochIds[currentEpochIdsIndex + i]];
        }
    }

    function totalSupply() public view override(ERC20, ITrancheVault) returns (uint256) {
        return ERC20.totalSupply();
    }

    /**
     * @notice Updates processed epochs
     */
    function closeEpoch(EpochInfo[] memory processedEpochs) external {
        uint256 count = processedEpochs.length;
        EpochInfo memory epoch;
        for (uint256 i; i < count; i++) {
            epoch = processedEpochs[i];
            epochMapping[epoch.epochId] = epoch;
        }

        if (epoch.totalProcessedWithdrawalAmount >= epoch.totalRequestedWithdrawalAmount) {
            currentEpochIdsIndex += count;
        } else if (count - 1 > 0) {
            currentEpochIdsIndex += count - 1;
        }

        // :update epochs array
        // :update currentEpochIndex
        // :burn/lock vault tokens
        // :withdraw underlying tokens from reserve
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        // :verify cap

        uint96[2] memory tranches = pool.refreshPool();
        // get correct total assets based on tranche index
        uint256 totalAssets = tranches[index];

        // :verify max senior ratio if it is senior vault

        uint256 price = totalAssets / ERC20.totalSupply();

        // :calculate minted shares

        // :transfer assets to reserve
        // :mint shares to receiver
    }

    /**
     * @notice Adds Redemption assets(underlying token amount) in current Redemption request
     */
    function addRedemptionRequest(uint256 assets) external {
        if (assets <= 0) {
            revert(); // assets is 0
        }

        uint96[2] memory tranches = pool.refreshPool();
        uint256 ta = tranches[index];
        uint256 price = ta / ERC20.totalSupply();
        uint256 shares = ERC20.balanceOf(msg.sender);
        uint256 userAssets = price * shares;

        UserRedemptionInfo memory redepmptionInfo = userRedemptionInfos[msg.sender];
        if (redepmptionInfo.totalRequestedAmount + assets > userAssets) {
            revert(); // assets is too big
        }

        UserRedemptionRequest[] storage requests = userRedemptionRequests[msg.sender];
        UserRedemptionRequest memory request = requests[requests.length - 1];
        uint256 epochId = epochManager.currentEpochId();
        if (request.epochId == epochId) {
            // add assets in current Redemption request
            request.RedemptionAmount += uint96(assets);
            requests[requests.length - 1] = request;
        } else {
            // no Redemption request, create a new one
            request.epochId = uint64(epochId);
            request.RedemptionAmount = uint96(assets);
            requests.push(request);
        }

        EpochInfo memory epochInfo = epochMapping[epochId];
        if (epochInfo.totalRequestedWithdrawalAmount > 0) {
            epochInfo.totalRequestedWithdrawalAmount += uint96(assets);
        } else {
            epochIds.push(epochId);
            epochInfo.epochId = uint64(epochId);
            epochInfo.totalRequestedWithdrawalAmount = uint96(assets);
        }
        epochMapping[epochId] = epochInfo;

        userRedemptionInfos[msg.sender] = redepmptionInfo;

        // :send an event
    }

    /**
     * @notice Removes Redemption assets(underlying token amount) from current Redemption request
     */
    function removeRedemptionRequest(uint256 assets) external {
        if (assets <= 0) {
            revert(); // assets is 0
        }

        UserRedemptionRequest[] storage requests = userRedemptionRequests[msg.sender];
        uint256 lastIndex = requests.length - 1;
        UserRedemptionRequest memory request = requests[lastIndex];
        uint256 epochId = epochManager.currentEpochId();
        if (request.epochId < epochId || request.RedemptionAmount < assets) {
            // only remove from current Redemption request
            revert();
        }

        request.RedemptionAmount -= uint96(assets);
        if (request.RedemptionAmount > 0) {
            requests[lastIndex] = request;
        } else {
            delete requests[lastIndex];
        }

        UserRedemptionInfo memory redepmptionInfo = userRedemptionInfos[msg.sender];
        redepmptionInfo.totalRequestedAmount -= uint96(assets);
        userRedemptionInfos[msg.sender] = redepmptionInfo;

        EpochInfo memory epochInfo = epochMapping[epochId];
        epochInfo.totalRequestedWithdrawalAmount -= uint96(assets);
        if (epochInfo.totalRequestedWithdrawalAmount > 0) {
            epochMapping[epochId] = epochInfo;
        } else {
            delete epochMapping[epochId];
            lastIndex = epochIds.length - 1;
            assert(epochIds[lastIndex] == epochId);
            delete epochIds[lastIndex];
        }

        // :send an event
    }

    /**
     * @notice Transfers processed underlying tokens to the user
     */
    function disburse() external {
        UserRedemptionInfo memory RedemptionInfo = _updateUserWithdrawable(msg.sender);
        // :transfer totalWithdrawableAmount to user
        // :set RedemptionInfo.totalWithdrawableAmount to 0
    }

    function totalAssets() external view returns (uint256) {
        return pool.trancheTotalAssets(index);
    }

    /**
     * @notice Calculates withdrawable amount from the last index of user Redemption request array
     * to current processed user Redemption request
     */
    function _updateUserWithdrawable(address user) internal returns (UserRedemptionInfo memory) {
        UserRedemptionInfo memory RedemptionInfo = userRedemptionInfos[user];
        UserRedemptionRequest[] storage requests = userRedemptionRequests[msg.sender];
        EpochInfo memory ei = epochMapping[epochIds[currentEpochIdsIndex]];

        // :iterate processed Redemption request from RedemptionInfo.currentIndex to ei.epochId (not included)
        // :sum up processed RedemptionAmount and processed redeemShare
        // :update RedemptionInfo.totalWithdrawableAmount
        // :burn user's shares
    }
}
