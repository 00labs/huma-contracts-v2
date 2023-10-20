// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IProfitEscrow} from "./interfaces/IProfitEscrow.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {ProfitEscrowStorage} from "./ProfitEscrowStorage.sol";
import {Errors} from "./Errors.sol";
import {DEFAULT_DECIMALS_FACTOR} from "./SharedDefs.sol";

// TODO FirstLossCover LP token transfer

contract ProfitEscrow is PoolConfigCache, ProfitEscrowStorage, IProfitEscrow {
    event CallerSet(address _caller);
    event ProfitAdded(uint256 profit);
    event PrincipalDeposited(address indexed account, uint256 amount);
    event PrincipalWithdrawn(address indexed account, uint256 amount);
    event ProfitClaimed(address indexed account, uint256 amount);

    constructor() {
        // _disableInitializers();
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);
    }

    function initialize(address _caller, PoolConfig _poolConfig) external initializer {
        _initialize(_poolConfig);
        caller = _caller;
    }

    function setCaller(address _caller) external {
        poolConfig.onlyPoolOwner(msg.sender);
        caller = _caller;

        emit CallerSet(_caller);
    }

    function addProfit(uint256 profit) external {
        if (profit == 0) revert Errors.zeroAmountProvided();
        _onlyCaller();

        EscrowInfo memory escrowInfo = _escrowInfo;
        assert(escrowInfo.totalShares != 0);
        escrowInfo.accRewardPerShare += uint96(
            (profit * DEFAULT_DECIMALS_FACTOR) / escrowInfo.totalShares
        );
        _escrowInfo = escrowInfo;

        totalRewards += profit;

        emit ProfitAdded(profit);
    }

    function deposit(address account, uint256 amount) external {
        if (amount == 0) revert Errors.zeroAmountProvided();
        if (account == address(0)) revert Errors.zeroAddressProvided();
        _onlyCaller();

        EscrowInfo memory escrowInfo = _escrowInfo;
        UserInfo memory tempUserInfo = userInfo[account];

        // When the user deposits principal, `rewardDebt` increases to account for the profits that have already been
        // accrued per share but were not contributed by the newly deposited amount. This ensures that when profits
        // are distributed, users can only claim profits generated while their principal was actively contributing
        // to the pool.
        tempUserInfo.rewardDebt += int96(
            int256((amount * escrowInfo.accRewardPerShare) / DEFAULT_DECIMALS_FACTOR)
        );
        tempUserInfo.amount += uint96(amount);
        userInfo[account] = tempUserInfo;

        escrowInfo.totalShares += uint96(amount);
        _escrowInfo = escrowInfo;

        emit PrincipalDeposited(account, amount);
    }

    function withdraw(address account, uint256 amount) external {
        if (amount == 0) revert Errors.zeroAmountProvided();
        if (account == address(0)) revert Errors.zeroAddressProvided();
        _onlyCaller();

        EscrowInfo memory escrowInfo = _escrowInfo;
        UserInfo memory tempUserInfo = userInfo[account];

        // When the user withdraws principal, `rewardDebt` decreases to account for the profits generated while
        // the principal was in the pool but have not yet been claimed. This adjustment ensures that the user can
        // claim the correct amount of profits when they call the claim function.
        // Note that `rewardDebt` can become negative here if the user withdraws principal before claiming
        // their profits. The negative value indicates that the user's principal had not contributed to the generation
        // of some of the profits they are entitled to claim. This acts as a correction mechanism to ensure that the
        // user's claimable profits are adjusted accordingly.
        tempUserInfo.rewardDebt -= int96(
            int256((amount * escrowInfo.accRewardPerShare) / DEFAULT_DECIMALS_FACTOR)
        );
        // TODO: should we revert if the amount exceeds the user's amount?
        tempUserInfo.amount -= uint96(amount);
        userInfo[account] = tempUserInfo;

        escrowInfo.totalShares -= uint96(amount);
        _escrowInfo = escrowInfo;

        emit PrincipalWithdrawn(account, amount);
    }

    // TODO: should we rename this to `claimProfit` to be more explicit?
    function claim(uint256 amount) external {
        if (amount == 0) revert Errors.zeroAmountProvided();

        EscrowInfo memory escrowInfo = _escrowInfo;
        UserInfo memory tempUserInfo = userInfo[msg.sender];

        // TODO: should we return early if the msg.sender does not exist in userInfo?

        uint256 tempClaimable = uint256(
            int256(
                (tempUserInfo.amount * escrowInfo.accRewardPerShare) / DEFAULT_DECIMALS_FACTOR
            ) - tempUserInfo.rewardDebt
        );
        if (amount > tempClaimable) revert Errors.todo();

        // `rewardDebt` decreases in value here when profits are claimed to prevent users from claiming the
        // same profits multiple times.
        tempUserInfo.rewardDebt += int96(int256(amount));
        userInfo[msg.sender] = tempUserInfo;

        poolSafe.withdraw(msg.sender, amount);

        emit ProfitClaimed(msg.sender, amount);
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
