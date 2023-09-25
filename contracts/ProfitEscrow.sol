// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {IProfitEscrow} from "./interfaces/IProfitEscrow.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {ProfitEscrowStorage} from "./ProfitEscrowStorage.sol";
import {Errors} from "./Errors.sol";
import "./SharedDefs.sol";

// TODO FirstLossCover LP token transfer

contract ProfitEscrow is PoolConfigCache, ProfitEscrowStorage, IProfitEscrow {
    constructor() {
        // _disableInitializers();
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);
    }

    function initialize(address _caller, PoolConfig _poolConfig) external initializer {
        _initialize(_poolConfig);
        caller = _caller;
    }

    function setCaller(address _caller) external {
        poolConfig.onlyPoolOwner(msg.sender);
        caller = _caller;

        // TODO emit event
    }

    function addProfit(uint256 profit) external {
        if (profit == 0) revert Errors.zeroAmountProvided();
        _onlyCaller();

        EscrowInfo memory escrowInfo = _escrowInfo;
        escrowInfo.accRewardPerShare += uint96(
            (profit * DEFAULT_DECIMALS_FACTOR) / escrowInfo.totalShares
        );
        _escrowInfo = escrowInfo;

        totalRewards += profit;

        // TODO emit event
    }

    function deposit(address account, uint256 amount) external {
        if (amount == 0) revert Errors.zeroAmountProvided();
        if (account == address(0)) revert Errors.zeroAddressProvided();
        _onlyCaller();

        EscrowInfo memory escrowInfo = _escrowInfo;
        UserInfo memory tempUserInfo = userInfo[account];

        tempUserInfo.rewardDebt += int96(
            int256((amount * escrowInfo.accRewardPerShare) / DEFAULT_DECIMALS_FACTOR)
        );
        tempUserInfo.amount += uint96(amount);
        userInfo[account] = tempUserInfo;

        escrowInfo.totalShares += uint96(amount);
        _escrowInfo = escrowInfo;

        // TODO emit event
    }

    function withdraw(address account, uint256 amount) external {
        if (amount == 0) revert Errors.zeroAmountProvided();
        if (account == address(0)) revert Errors.zeroAddressProvided();
        _onlyCaller();

        EscrowInfo memory escrowInfo = _escrowInfo;
        UserInfo memory tempUserInfo = userInfo[account];

        // Effects
        tempUserInfo.rewardDebt -= int96(
            int256((amount * escrowInfo.accRewardPerShare) / DEFAULT_DECIMALS_FACTOR)
        );
        tempUserInfo.amount -= uint96(amount);
        userInfo[account] = tempUserInfo;

        escrowInfo.totalShares -= uint96(amount);
        _escrowInfo = escrowInfo;

        // TODO emit event
    }

    function claim(uint256 amount) external {
        if (amount == 0) revert Errors.zeroAmountProvided();

        EscrowInfo memory escrowInfo = _escrowInfo;
        UserInfo memory tempUserInfo = userInfo[msg.sender];

        uint256 tempClaimable = uint256(
            int256(
                (tempUserInfo.amount * escrowInfo.accRewardPerShare) / DEFAULT_DECIMALS_FACTOR
            ) - tempUserInfo.rewardDebt
        );
        if (amount > tempClaimable) revert Errors.todo();

        tempUserInfo.rewardDebt += int96(int256(amount));
        userInfo[msg.sender] = tempUserInfo;

        poolVault.withdraw(msg.sender, amount);

        // TODO emit event
    }

    function claimable(address account) external view returns (uint256) {
        EscrowInfo memory escrowInfo = _escrowInfo;
        UserInfo memory tempUserInfo = userInfo[account];

        return
            uint256(
                int256(
                    (tempUserInfo.amount * escrowInfo.accRewardPerShare) / DEFAULT_DECIMALS_FACTOR
                ) - tempUserInfo.rewardDebt
            );
    }

    function _onlyCaller() internal view {
        if (msg.sender != caller) revert Errors.todo();
    }
}
