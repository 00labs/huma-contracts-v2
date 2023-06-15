// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {EpochManager} from "./EpochManager.sol";

interface IFlexTrancheVaultLike {
    function flexEpochOrder() external view returns (uint256 submittedRedeemShare);

    function submitFlexEpochOrder() external returns (uint256 submittedRedeemShare);

    function closeFlexEpoch(uint256 epochId, uint256 price, uint256[2] memory data) external;
}

interface IPoolLike {
    function submitFlexPrincipalOrder(uint256 amount) external;
}

contract FlexEpochManager is EpochManager {
    uint256 public FlexEpochCount;
    uint256 tokenPrice;

    function closeEpoch() public virtual override {
        uint96[2] memory tranches;

        // check if needs to sumbit flex epoch orders
        bool needToSubmitFlexEpochOrder;
        if (needToSubmitFlexEpochOrder) {
            uint256 seniorRedeemShare = IFlexTrancheVaultLike(address(seniorTranche))
                .submitFlexEpochOrder();
            uint256 juniorRedeemShare = IFlexTrancheVaultLike(address(juniorTranche))
                .submitFlexEpochOrder();

            uint256 redeemShare = seniorRedeemShare + juniorRedeemShare;

            IPoolLike(address(pool)).submitFlexPrincipalOrder(redeemShare);
        }

        bool needToProcessFlexEpochOrder;
        if (needToProcessFlexEpochOrder) {
            uint256 seniorRedeemShare = IFlexTrancheVaultLike(address(seniorTranche))
                .flexEpochOrder();
            uint256 juniorRedeemShare = IFlexTrancheVaultLike(address(juniorTranche))
                .flexEpochOrder();

            uint256[2] memory results = _executeFlexEpoch(
                tranches,
                [seniorRedeemShare, juniorRedeemShare]
            );

            uint256 epochId = currentEpochId;

            IFlexTrancheVaultLike(address(seniorTranche)).closeFlexEpoch(
                epochId,
                tokenPrice,
                [seniorRedeemShare, results[0]]
            );

            IFlexTrancheVaultLike(address(juniorTranche)).closeFlexEpoch(
                epochId,
                tokenPrice,
                [juniorRedeemShare, results[1]]
            );
        }

        super.closeEpoch();
    }

    function _executeFlexEpoch(
        uint96[2] memory tranches,
        uint256[2] memory orderData
    ) internal view returns (uint256[2] memory results) {}
}
